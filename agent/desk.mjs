// Polls the course tracker and works each issue from the triage skill.
// Env: TRACKER_URL, TRACKER_TOKEN, LLM_BASE_URL, LLM_MODEL, LLM_KEY,
//      FEED_URL (optional until the round opens), LIVE_URL (optional),
//      CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (for wrangler deploy)
import { execFile } from "node:child_process";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { answerKey, caughtUp, mentionsIssue, needsPickup, parseShip, recordHeader, shouldRun } from "./judge.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = resolve(root, ".agents/skills/triage/SKILL.md");
const pollMs = Number(process.env.POLL_MS || 20000);
const maxSteps = Number(process.env.MAX_STEPS || 24);
const maxAttempts = 2;

const secrets = [
  process.env.TRACKER_TOKEN,
  process.env.LLM_KEY,
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.PROD_ADMIN_TOKEN,
].filter(Boolean);

const mask = (value) => secrets.reduce((text, secret) => text.replaceAll(secret, "****"), String(value));

async function log(line) {
  const text = mask(line);
  console.log(text);
  await mkdir(resolve(root, "out"), { recursive: true });
  await appendFile(resolve(root, "out/desk.log"), text + "\n");
}

function need(name) {
  if (!process.env[name]) throw new Error(`missing env ${name}`);
  return process.env[name];
}

function trackerUrl(path) {
  const base = process.env.TRACKER_URL.endsWith("/")
    ? process.env.TRACKER_URL
    : `${process.env.TRACKER_URL}/`;
  return new URL(String(path).replace(/^\//, ""), base);
}

async function tracker(method, path, body) {
  const response = await fetch(trackerUrl(path), {
    method,
    headers: {
      authorization: `Bearer ${process.env.TRACKER_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw body
  }
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed ? parsed.message : text;
    throw new Error(`${method} ${path} ${response.status}: ${message}`);
  }
  return parsed;
}

function exec(cmd, args) {
  return new Promise((resolveExec, reject) => {
    execFile(cmd, args, { cwd: root, env: process.env }, (error, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}`;
      if (error) reject(new Error(mask(`${cmd} ${args.join(" ")} failed: ${error.message}\n${output.slice(-2000)}`)));
      else resolveExec(output);
    });
  });
}

const CONFIG_PATHS = ["/debug", "/env", "/config"];

async function deploy() {
  const src = await readFile(resolve(root, "src/index.js"), "utf8");
  const servesConfig =
    CONFIG_PATHS.some((path) => src.includes(`'${path}'`) || src.includes(`"${path}"`)) ||
    /json\(\s*\{\s*env\b/.test(src);
  if (servesConfig) {
    throw new Error(
      "deploy refused: src/index.js serves environment or configuration. Skill rule: never serve environment, configuration or secrets on any route, sanitized or not. Remove that route, then deploy.",
    );
  }
  return deployCloudflare();
}

async function liveConfigRoutes() {
  const base = (process.env.LIVE_URL || "").replace(/\/$/, "");
  if (!base) return [];
  const found = [];
  for (const path of CONFIG_PATHS) {
    const response = await fetch(base + path);
    if (response.status !== 404) found.push(`${path} answers ${response.status}`);
  }
  return found;
}

async function deployCloudflare() {
  const feed = process.env.FEED_URL;
  if (feed) {
    const tomlPath = resolve(root, "wrangler.toml");
    const toml = await readFile(tomlPath, "utf8");
    const next = toml.replace(/FEED_URL\s*=\s*".*"/g, `FEED_URL = "${feed}"`);
    if (!/FEED_URL\s*=\s*".*"/.test(toml)) throw new Error("wrangler.toml has no FEED_URL assignment");
    if (next !== toml) await writeFile(tomlPath, next);
  }
  const output = await exec("npx", ["wrangler", "deploy", "--env", "production"]);
  const urls = [...output.matchAll(/https:\/\/[^\s)]+/g)].map((match) => match[0]);
  const live = urls.find((url) => url.includes("workers.dev")) || process.env.LIVE_URL || "";
  if (live) {
    process.env.LIVE_URL = live;
    await writeFile(resolve(root, "out/live.txt"), live);
  }
  await publish();
  return live || "deployed, no url in wrangler output";
}

async function publish() {
  if (!process.env.GITHUB_ACTIONS) return;
  const status = await exec("git", ["status", "--porcelain", "--", "src", "contract", "wrangler.toml"]);
  if (!status.trim()) return;
  await exec("git", ["add", "--", "src", "contract", "wrangler.toml"]);
  await exec("git", [
    "-c", "user.email=desk@users.noreply.github.com",
    "-c", "user.name=sched-prod desk",
    "commit",
    "-m", "Ship the live API",
  ]);
  await exec("git", ["push"]);
}

const allowed = (method, path) => {
  if (method === "GET" && (path === "/issues" || path === "/records" || path === "/shiplog")) return true;
  if (method === "GET" && /^\/issues\/\d+$/.test(path)) return true;
  if (method === "GET" && /^\/records\/[0-9]{4}-[a-z0-9-]+$/.test(path)) return true;
  if (method === "POST" && /^\/issues\/\d+\/(comments|labels|close)$/.test(path)) return true;
  if (method === "PUT" && /^\/records\/[0-9]{4}-[a-z0-9-]+$/.test(path)) return true;
  if (method === "POST" && path === "/shiplog") return true;
  return false;
};

function insideRepo(path) {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel.startsWith("..") || rel === "") throw new Error("path escapes the repo");
  if (rel.startsWith(".git") || rel.startsWith("node_modules") || rel.startsWith(".github")) {
    throw new Error("path is not editable");
  }
  return full;
}

async function liveGet(path) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("path must start with /");
  const base = need("LIVE_URL").replace(/\/$/, "");
  const response = await fetch(base + path);
  const text = await response.text();
  return `${response.status} ${text.slice(0, 4000)}`;
}

const tools = [
  {
    type: "function",
    function: {
      name: "tracker",
      description: "Call the course tracker. method, path and optional JSON body. Paths are the ones in AGENTS.md.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string" },
          path: { type: "string" },
          body: { type: "object" },
        },
        required: ["method", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file in the sched-prod-api repo.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file in the repo. Use this to change src before deploy.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deploy",
      description: "Deploy the API to the live https address and return that address.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "live_get",
      description: "GET a path on the live API. path starts with /.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

async function callTool(name, args) {
  if (name === "tracker") {
    if (!allowed(args.method, args.path)) throw new Error(`tracker call not allowed: ${args.method} ${args.path}`);
    if (args.method === "PUT" && recordHeader(args.body?.text) === null) {
      throw new Error(
        "record refused by host: text must start with the header from decisions/TEMPLATE.md, between two '---' lines, with id, title, issue, status and signed-by (empty). Rewrite it and PUT again.",
      );
    }
    const result = await tracker(args.method, args.path, args.body);
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  if (name === "read_file") return readFile(insideRepo(args.path), "utf8");
  if (name === "write_file") {
    const full = insideRepo(args.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, args.text);
    return `wrote ${args.path}`;
  }
  if (name === "deploy") return deploy();
  if (name === "live_get") return liveGet(args.path);
  throw new Error(`unknown tool ${name}`);
}

async function runIssue(issue, skill, task = `Work issue #${issue.n} through to its ship line.`) {
  const messages = [
    {
      role: "system",
      content: `Follow this skill exactly. Use only the tools given.\n\n${skill}`,
    },
    {
      role: "user",
      content: [
        task,
        `Live address: ${process.env.LIVE_URL || "(deploy has not reported one yet)"}`,
        `Issue JSON:\n${JSON.stringify(issue)}`,
      ].join("\n\n"),
    },
  ];
  for (let step = 1; step <= maxSteps; step++) {
    const response = await fetch(`${need("LLM_BASE_URL").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${need("LLM_KEY")}`,
      },
      body: JSON.stringify({
        model: need("LLM_MODEL"),
        temperature: 0,
        parallel_tool_calls: false,
        messages,
        tools,
      }),
    });
    if (!response.ok) throw new Error(`LLM ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const message = (await response.json()).choices[0].message;
    messages.push(message);
    if (message.content) await log(`#${issue.n} [${step}] ${message.content.slice(0, 500)}`);
    if (!message.tool_calls?.length) return;
    const call = message.tool_calls[0];
    for (const extra of message.tool_calls.slice(1)) {
      messages.push({
        role: "tool",
        tool_call_id: extra.id,
        content: "ERROR: not run. Call one tool at a time.",
      });
    }
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      args = {};
    }
    await log(`#${issue.n} [${step}] ${call.function.name} ${JSON.stringify(args).slice(0, 300)}`);
    let text;
    try {
      text = await callTool(call.function.name, args);
    } catch (error) {
      text = `ERROR: ${error.message}`;
    }
    await log(`#${issue.n} [${step}] result ${String(text).slice(0, 500)}`);
    messages.push({ role: "tool", tool_call_id: call.id, content: String(text).slice(0, 12000) });
  }
}

async function main() {
  need("TRACKER_URL");
  need("TRACKER_TOKEN");
  process.env.LLM_BASE_URL ||= "https://api.x.ai/v1";
  process.env.LLM_MODEL ||= "grok-4.20-0309-non-reasoning";
  need("LLM_KEY");
  const skill = await readFile(skillPath, "utf8");
  const attempts = new Map();
  if (process.env.FEED_URL) {
    await log("startup deploy (cloudflare)");
    try {
      await log(await deploy());
    } catch (error) {
      await log(`startup deploy failed, going on: ${error.message.slice(0, 400)}`);
    }
  }
  if (process.env.RECHECK === "true") {
    const reviewed = await tracker("GET", "/issues");
    const shipped = parseShip((await tracker("GET", "/shiplog")).text);
    const leaks = await liveConfigRoutes();
    await log(`host audit: ${leaks.length ? leaks.join(", ") : "no config routes live"}`);
    for (const issue of (reviewed.issues || []).sort((a, b) => a.n - b.n)) {
      if (!shipped.has(issue.n)) continue;
      const text = `${issue.title}\n${issue.body}`.toLowerCase();
      const audit = leaks.filter((leak) => text.includes(leak.split(" ")[0].slice(1)));
      let note = audit.length
        ? `\n\nHost audit: on the live address ${audit.join(", ")}. This breaks the Never rule "Never serve environment, configuration or secrets on any route, sanitized or not" and Decide step 2. Decline this issue: remove the route from src/index.js, deploy, check it answers 404, comment why, and post "#${issue.n} · declined · live: ✓ · open risks: none".`
        : "";
      const row = shipped.get(issue.n);
      const ownerSpoke = (issue.thread || []).some((entry) => entry.by === "owner");
      const ownerNamed = /^owner:\s*\S+/m.test(issue.body || "");
      if (!audit.length && ownerNamed && row.verb !== "asked" && !ownerSpoke) {
        note += `\n\nHost check: this issue names an owner ("owner:" line) and nobody asked the owner. An unsigned record is a proposal and decides nothing. Ask now (Review section): write your own record with the next free id, label needs-human, comment the numbered options with your recommendation, ship "#${issue.n} · asked · live: ✗ · open risks: <record id> owner". Do this even though the issue is closed.`;
      } else if (!audit.length && (row.verb === "declined" || row.verb === "closed") && !ownerSpoke) {
        note += `\n\nHost check: you ${row.verb} this issue without the owner. Read Decide step 1 again. If the issue adds, drops or reshapes a field on an existing answer, writes to the production feed, or names an owner of its own, it is AUT-2 and the course rejected the decline: ask now (Review section), even though the issue is closed.`;
      }
      try {
        await runIssue(issue, skill, `Review issue #${issue.n} (see the Review section). Its ship line now: ${JSON.stringify(shipped.get(issue.n))}${note}`);
      } catch (error) {
        await log(`review #${issue.n} failed: ${error.message}`);
      }
    }
  }
  for (;;) {
    try {
      const snapshot = await tracker("GET", "/issues");
      const ship = parseShip((await tracker("GET", "/shiplog")).text);
      const records = (await tracker("GET", "/records")).records || [];
      for (const issue of snapshot.issues || []) {
        if (!needsPickup(issue, ship, mentionsIssue(records, issue.n))) continue;
        await tracker("POST", `/issues/${issue.n}/comments`, { body: `Picked up #${issue.n}.` });
        await log(`picked up #${issue.n}`);
      }
      const again = await tracker("GET", "/issues");
      const shipNow = parseShip((await tracker("GET", "/shiplog")).text);
      const recordsNow = (await tracker("GET", "/records")).records || [];
      const next = (again.issues || [])
        .filter((issue) => {
          const key = answerKey(issue);
          if ((attempts.get(key) || 0) >= maxAttempts) return false;
          return shouldRun(issue, shipNow, mentionsIssue(recordsNow, issue.n));
        })
        .sort((a, b) => a.n - b.n)[0];
      if (next) {
        const key = answerKey(next);
        attempts.set(key, (attempts.get(key) || 0) + 1);
        try {
          await runIssue(next, skill);
        } catch (error) {
          await log(`#${next.n} failed: ${error.message}`);
        }
      } else if (caughtUp(again, shipNow)) {
        await log("caught up");
        return;
      }
    } catch (error) {
      await log(`poll failed: ${error.message}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(mask(error.stack || error.message));
    process.exit(1);
  });
}
