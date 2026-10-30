#!/usr/bin/env node
'use strict';
/**
 * 把本仓库发布到 GitHub —— 全程只走 api.github.com，不碰 github.com。
 *
 * 为什么不用 `git push`
 * --------------------
 * 这台机器所在的网络会对 github.com 这个域名做 TLS 层拦截：
 *   - TCP 到 20.205.243.166:443 能握手（甚至 80 端口也通）
 *   - 但带 SNI=github.com 的 ClientHello 一发出去就再没有回包（15s 零字节）
 *   - 换成 140.82.112.3 等其它 GitHub 官方 IP，现象完全相同 → 不是 DNS 污染
 *   - 而 api.github.com / ssh.github.com / codeload.github.com 都正常
 * 所以 gh 的 device flow（要访问 github.com/login/oauth/access_token）
 * 和 git push（要访问 github.com/<owner>/<repo>.git）都不可能成功。
 * api.github.com 可以，因此改用 Git Data API 直写对象：
 *   blob（文件内容）→ tree（目录快照）→ commit → ref（分支指针）
 * 效果与 push 一致，克隆下来的仓库、提交历史、文件权限都正常。
 *
 * 用法
 * ----
 *   1. 建一个有 repo 权限的 Classic Token：
 *      GitHub → Settings → Developer settings → Personal access tokens
 *      → Tokens (classic) → Generate new token → 勾选 repo
 *   2. 设为环境变量后运行：
 *        GITHUB_TOKEN=ghp_xxx node tools/publish-github.js
 *      或把 token 写进同目录的 .github-token 文件（已在 .gitignore 里）
 *   3. 可选参数：
 *        --repo <name>     仓库名，默认取 package 名（finguard）
 *        --private         建成私有仓库
 *        --dry-run         只列出将要上传的文件，不发网络请求
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const API_HOST = 'api.github.com';
const GIT = process.env.GIT_BIN || 'git';

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const REPO = opt('--repo', 'finguard');
const PRIVATE = flag('--private');
const DRY = flag('--dry-run');

/* ---------------- token ---------------- */

function readToken() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) {
    return process.env.GITHUB_TOKEN.trim();
  }
  const f = path.join(__dirname, '.github-token');
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  }
  console.error(
    '\n没有找到 GITHUB_TOKEN。\n\n' +
    '请先创建一个带 repo 权限的 Classic Token：\n' +
    '  GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)\n' +
    '  → Generate new token → 勾选 repo → 生成后复制\n\n' +
    '然后二选一：\n' +
    '  GITHUB_TOKEN=ghp_xxx node tools/publish-github.js\n' +
    '  把 token 写进 tools/.github-token 再运行\n'
  );
  process.exit(2);
}

/* ---------------- HTTP ---------------- */

function api(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(
      {
        host: API_HOST,
        path: urlPath,
        method,
        headers: {
          'User-Agent': 'finguard-publisher',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: 'Bearer ' + token,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
        timeout: 60000,
      },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try { json = d ? JSON.parse(d) : null; } catch (_) { /* 非 JSON 响应 */ }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const remain = res.headers['x-ratelimit-remaining'];
            if (remain !== undefined) STATE.rate = Number(remain);
            return resolve(json);
          }
          const err = new Error(
            `${method} ${urlPath} → ${res.statusCode} ${json && json.message ? json.message : d.slice(0, 200)}`
          );
          err.status = res.statusCode;
          err.body = json;
          reject(err);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时：${method} ${urlPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const STATE = { rate: null };

/** 5xx / 网络抖动重试，指数退避 */
async function apiRetry(method, urlPath, body, token, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await api(method, urlPath, body, token);
    } catch (e) {
      last = e;
      const retriable = !e.status || e.status >= 500 || e.status === 429;
      if (!retriable || i === tries - 1) throw e;
      const wait = 1200 * Math.pow(2, i);
      process.stderr.write(`  ${e.message} · ${wait}ms 后重试\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

/* ---------------- 收集文件 ---------------- */

/**
 * 用 `git ls-files` 取文件列表，而不是自己解析 .gitignore。
 * 好处是上传的内容和本地提交内容严格一致，不会把构建产物带上去。
 */
function listFiles() {
  let out;
  try {
    out = execFileSync(GIT, ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch (e) {
    console.error('读取 git 索引失败。请确认在仓库根目录、且已 git add。');
    console.error(String(e.message || e).slice(0, 300));
    process.exit(1);
  }
  return out.split('\0').filter(Boolean);
}

const MB = 1024 * 1024;
const MAX_BLOB = 40 * MB; // GitHub blobs API 上限 100MB，留足 base64 膨胀余量

/* ---------------- 回填仓库地址 ---------------- */

// 只回填「给人看的文档」，绝不碰工具脚本自己的源码。
// 否则会把 md2docx.py / publish-github.js 里出现的 __REPO_URL__ 字符串字面量一起替换掉，
// 破坏脚本逻辑（真实踩过的坑）。
const TEXT_EXT = new Set(['.md', '.txt']);

/**
 * 仓库建好之后，把文档里的 __REPO_URL__ / __REPO_SLUG__ 换成真实地址。
 * 这样只要跑一次发布，README、提交清单、作品信息里的地址就都是可点开的真链接，
 * 不需要人工再改一遍（也避免漏改）。
 */
function fillPlaceholders(files, full, htmlUrl) {
  const changed = [];
  for (const f of files) {
    if (!TEXT_EXT.has(path.extname(f).toLowerCase())) continue;
    if (f.startsWith('tools/') || f.startsWith('docs/video') || f.includes('node_modules')) continue;
    const abs = path.join(ROOT, f);
    let s;
    try {
      s = fs.readFileSync(abs, 'utf8');
    } catch (_) {
      continue;
    }
    if (!s.includes('__REPO_URL__') && !s.includes('__REPO_SLUG__')) continue;
    const out = s
      .split('__REPO_URL__').join(htmlUrl)
      .split('__REPO_SLUG__').join(full);
    fs.writeFileSync(abs, out, 'utf8');
    changed.push(f);
  }
  return changed;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const files = listFiles();
  let total = 0;
  for (const f of files) total += fs.statSync(path.join(ROOT, f)).size;

  console.log(`本地仓库：${files.length} 个文件，${(total / MB).toFixed(1)} MB`);

  const oversize = files.filter((f) => fs.statSync(path.join(ROOT, f)).size > MAX_BLOB);
  if (oversize.length) {
    console.error('以下文件超过单个 blob 上限，请先移出仓库或用 Git LFS：\n  ' + oversize.join('\n  '));
    process.exit(1);
  }

  if (DRY) {
    files.forEach((f) => console.log(`  ${String(fs.statSync(path.join(ROOT, f)).size).padStart(9)}  ${f}`));
    console.log('\n--dry-run：未发送任何网络请求。');
    return;
  }

  const token = readToken();

  /* 1. 身份 */
  const me = await apiRetry('GET', '/user', null, token);
  console.log(`已认证：${me.login}`);

  /* 2. 仓库（没有就建） */
  const full = `${me.login}/${REPO}`;
  let repo = null;
  try {
    repo = await apiRetry('GET', `/repos/${full}`, null, token);
    console.log(`仓库已存在：${repo.html_url}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    console.log(`仓库不存在，正在创建 ${full} …`);
    repo = await apiRetry('POST', '/user/repos', {
      name: REPO,
      description: 'FinGuard 守护者 —— 一个每一笔都能问责的 AI Banking Agent',
      homepage: '',
      private: PRIVATE,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false, // 由我们写入首个 commit，不要自动生成 README
    }, token);
    console.log(`已创建：${repo.html_url}`);
  }

  /* 2.5 回填仓库地址：改完立刻提交，保证上传内容与本地提交严格一致 */
  const changed = fillPlaceholders(files, full, repo.html_url);
  if (changed.length) {
    execFileSync(GIT, ['add', ...changed], { cwd: ROOT });
    execFileSync(GIT, ['commit', '-m', `回填仓库地址：${full}`], { cwd: ROOT });
    console.log(`已回填仓库地址：${changed.length} 个文件`);
    changed.forEach((f) => console.log(`  ${f}`));
  } else {
    console.log('文档里没有待回填的占位符');
  }

  /* 3. 已有分支？决定是「首次提交」还是「追加提交」 */  let parentSha = null;
  let baseTree = null;
  try {
    const ref = await apiRetry('GET', `/repos/${full}/git/ref/heads/${repo.default_branch || 'main'}`, null, token);
    parentSha = ref.object.sha;
    const commit = await apiRetry('GET', `/repos/${full}/git/commits/${parentSha}`, null, token);
    baseTree = commit.tree.sha;
    console.log(`已有分支 ${repo.default_branch}，本次为增量提交（父提交 ${parentSha.slice(0, 7)}）`);
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
    // 完全空仓库（无任何 commit）时，GitHub 的 blob / tree 创建接口都会返回
    // 409 "Git Repository is empty"。唯一对空仓库有效的写入口是 contents API，
    // 用它创建 README.md 激活仓库（会自动生成初始 commit 与 main 分支）。
    console.log('远端为空仓库，用 contents API 写入 README 激活仓库 …');
    const readme = files.find((f) => f === 'README.md') || files[0];
    const readmeBuf = fs.readFileSync(path.join(ROOT, readme));
    await apiRetry('PUT', `/repos/${full}/contents/${encodeURIComponent(readme)}`, {
      message: 'init',
      content: readmeBuf.toString('base64'),
      encoding: 'base64',
    }, token);
    const branch = repo.default_branch || 'main';
    const ref = await apiRetry('GET', `/repos/${full}/git/ref/heads/${branch}`, null, token);
    parentSha = ref.object.sha;
    const commit = await apiRetry('GET', `/repos/${full}/git/commits/${parentSha}`, null, token);
    baseTree = commit.tree.sha;
    console.log(`已激活仓库（初始提交 ${parentSha.slice(0, 7)}，含 ${readme}），继续上传其余文件`);
  }

  /* 4. 逐文件上传 blob */
  // GitHub 安全限制：.github/workflows/*.yml 不能通过 Git Data API 或 contents API
  // 写入（防止恶意 token 注入 workflow 执行任意代码），tree 创建会返回 404。
  // 这类文件单独记录，稍后提示用 git push 推送。
  const workflowFiles = [];
  const entries = [];
  let done = 0;
  for (const f of files) {
    if (f.startsWith('.github/workflows/')) {
      workflowFiles.push(f);
      continue;
    }
    const abs = path.join(ROOT, f);
    const buf = fs.readFileSync(abs);
    const blob = await apiRetry('POST', `/repos/${full}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    }, token);
    // 可执行文件保留 100755，其余 100644
    const mode = (fs.statSync(abs).mode & 0o111) ? '100755' : '100644';
    entries.push({ path: f, mode, type: 'blob', sha: blob.sha });
    done++;
    if (done % 10 === 0 || done === files.length - workflowFiles.length) {
      process.stdout.write(`  上传 ${done}/${files.length - workflowFiles.length}\r`);
    }
  }
  process.stdout.write('\n');
  if (workflowFiles.length) {
    console.log(`已跳过 ${workflowFiles.length} 个 workflow 文件（GitHub 禁止 API 写入）：`);
    workflowFiles.forEach((f) => console.log(`  ${f}`));
  }

  /* 5. tree → commit → ref */
  const tree = await apiRetry('POST', `/repos/${full}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: entries,
  }, token);

  const localHead = (() => {
    try {
      return execFileSync(GIT, ['log', '-1', '--pretty=%B'], { cwd: ROOT }).toString('utf8').trim();
    } catch (_) {
      return 'Initial commit';
    }
  })();

  const commit = await apiRetry('POST', `/repos/${full}/git/commits`, {
    message: localHead,
    tree: tree.sha,
    ...(parentSha ? { parents: [parentSha] } : {}),
  }, token);

  if (parentSha) {
    await apiRetry('PATCH', `/repos/${full}/git/refs/heads/${repo.default_branch}`, {
      sha: commit.sha,
      force: false,
    }, token);
  } else {
    const branch = repo.default_branch || 'main';
    await apiRetry('POST', `/repos/${full}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    }, token).catch(async (e) => {
      // 某些账号默认分支是 master，ref 已存在时改为更新
      if (e.status === 422) {
        await apiRetry('PATCH', `/repos/${full}/git/refs/heads/${branch}`, { sha: commit.sha, force: true }, token);
      } else throw e;
    });
  }

  console.log(`\n完成：${repo.html_url}`);
  console.log(`提交：${commit.sha.slice(0, 7)} · ${entries.length} 个文件`);
  console.log(`克隆：git clone ${repo.clone_url}`);
}

main().catch((e) => {
  console.error('\n失败：' + (e.message || e));
  if (e.body) console.error('响应体：' + JSON.stringify(e.body));
  process.exit(1);
});
