import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── .env loader ────────────────────────────────────────────────────
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) {
      const key = t.slice(0, eq);
      if (!process.env[key]) process.env[key] = t.slice(eq + 1);
    }
  }
}

// ── Config ─────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || "").split(",").filter(Boolean).map(Number)
);
const GROUP_CHAT_ID = Number(process.env.GROUP_CHAT_ID);
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const CWD = process.env.WORKING_DIR || "/home/claude/workspace";
const STATE_FILE = join(__dirname, "state.json");
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const STALE_THRESHOLD_S = 30;
const ANSWER_TIMEOUT_MS = 300_000; // 5 min timeout for interactive questions

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

// ── State ──────────────────────────────────────────────────────────
let state = {
  sessionId: null,
  sessionCost: 0,
  totalCost: 0,
  offset: 0,
  crashLog: [],
};

function loadState() {
  try {
    if (existsSync(STATE_FILE))
      state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {}
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ── Telegram API ───────────────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, "");
}

async function apiCall(method, params = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${TG}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (data.ok) return data.result;
      if (data.error_code === 429) {
        const wait = (data.parameters?.retry_after || 5) * 1000;
        console.log(`Rate limited, waiting ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (data.description?.includes("message is not modified")) return null;
      if (i === retries - 1)
        console.error(`TG API ${method} failed:`, data.description);
      return null;
    } catch (err) {
      if (i === retries - 1)
        console.error(`TG API ${method} error:`, err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function sendMessage(chatId, text, parseMode = "HTML") {
  const result = await apiCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
  });
  if (!result && parseMode === "HTML") {
    return apiCall("sendMessage", { chat_id: chatId, text: stripHtml(text) });
  }
  return result;
}

async function editMessage(chatId, msgId, text, parseMode = "HTML") {
  const result = await apiCall("editMessageText", {
    chat_id: chatId,
    message_id: msgId,
    text,
    parse_mode: parseMode,
  });
  if (!result && parseMode === "HTML") {
    return apiCall("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: stripHtml(text),
    });
  }
  return result;
}

async function sendTyping(chatId) {
  await apiCall("sendChatAction", { chat_id: chatId, action: "typing" });
}

// ── Markdown → Telegram HTML ───────────────────────────────────────
function mdToHtml(md) {
  const codeBlocks = [];
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const ph = `\x00CB${codeBlocks.length}\x00`;
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(
      `<pre><code${cls}>${escapeHtml(code.trimEnd())}</code></pre>`
    );
    return ph;
  });

  const inlineCodes = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const ph = `\x00IC${inlineCodes.length}\x00`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return ph;
  });

  text = escapeHtml(text);

  // Headers → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // Bold and italic
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");
  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Bullet lists
  text = text.replace(/^[\s]*[-*]\s+(.+)$/gm, "  \u2022 $1");
  // Numbered lists
  text = text.replace(/^[\s]*(\d+)\.\s+(.+)$/gm, "  $1. $2");

  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[i]);
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[i]);

  return text;
}

// ── Message Splitting ──────────────────────────────────────────────
function splitMessage(text, limit = 4096) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= limit) {
      parts.push(rest);
      break;
    }
    let at = rest.lastIndexOf("\n\n", limit);
    if (at <= 0) at = rest.lastIndexOf("\n", limit);
    if (at <= 0) at = rest.lastIndexOf(" ", limit);
    if (at <= 0) at = limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, "");
  }
  return parts;
}

// ── Tool Use Formatting ────────────────────────────────────────────
function formatToolUse(block) {
  const { name, input = {} } = block;
  if (name === "Bash" && input.command)
    return `\u{1F527} Bash: ${input.command.slice(0, 80)}`;
  if (name === "Read" && input.file_path)
    return `\u{1F4C4} Read: ${input.file_path}`;
  if (name === "Edit" && input.file_path)
    return `\u{270F}\u{FE0F} Edit: ${input.file_path}`;
  if (name === "Write" && input.file_path)
    return `\u{1F4DD} Write: ${input.file_path}`;
  if ((name === "Glob" || name === "Grep") && input.pattern)
    return `\u{1F50D} ${name}: ${input.pattern}`;
  return `\u{1F527} ${name}`;
}

// ── Interactive Q&A (AskUserQuestion) ──────────────────────────────
const pendingAnswers = new Map(); // tg msgId → { resolve, question, chatId, ... }
let pendingTextInput = null; // { resolve, chatId, questionMsgId }

function waitForTelegramAnswer(chatId, question) {
  return new Promise(async (resolve) => {
    const isMulti = question.multiSelect;
    const selected = new Set();

    function buildKeyboard() {
      const kb = question.options.map((opt, i) => [
        {
          text: isMulti
            ? (selected.has(i) ? "\u2705 " : "\u2B1C ") + opt.label
            : opt.label,
          callback_data: `qa_${i}`,
        },
      ]);
      if (isMulti) kb.push([{ text: "\u2705 Done", callback_data: "qa_done" }]);
      kb.push([{ text: "\u270F\u{FE0F} Other...", callback_data: "qa_other" }]);
      return kb;
    }

    let qText = `\u2753 <b>${escapeHtml(question.header || "Question")}</b>\n\n${escapeHtml(question.question)}\n`;
    if (isMulti) qText += "<i>(Select multiple, then tap Done)</i>\n";
    for (const opt of question.options) {
      qText += `\n\u2022 <b>${escapeHtml(opt.label)}</b>`;
      if (opt.description) qText += ` \u2014 ${escapeHtml(opt.description)}`;
    }

    const sent = await apiCall("sendMessage", {
      chat_id: chatId,
      text: qText,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buildKeyboard() },
    });

    if (!sent) {
      resolve(question.options[0]?.label || "");
      return;
    }

    const timer = setTimeout(() => {
      pendingAnswers.delete(sent.message_id);
      const def = isMulti && selected.size > 0
        ? [...selected].map((i) => question.options[i].label).join(", ")
        : question.options[0]?.label || "";
      editMessage(chatId, sent.message_id, `\u23F0 Timed out \u2192 <b>${escapeHtml(def)}</b>`);
      resolve(def);
    }, ANSWER_TIMEOUT_MS);

    pendingAnswers.set(sent.message_id, {
      resolve: (answer) => {
        clearTimeout(timer);
        pendingAnswers.delete(sent.message_id);
        resolve(answer);
      },
      question,
      chatId,
      isMulti,
      selected,
      buildKeyboard,
    });
  });
}

async function handleCallbackQuery(cbq) {
  await apiCall("answerCallbackQuery", { callback_query_id: cbq.id });

  const msgId = cbq.message?.message_id;
  const chatId = cbq.message?.chat?.id;
  const pending = pendingAnswers.get(msgId);
  if (!pending) return;

  const data = cbq.data;

  // "Other" — wait for free-text
  if (data === "qa_other") {
    pendingTextInput = {
      resolve: pending.resolve,
      chatId,
      questionMsgId: msgId,
    };
    await apiCall("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text: "\u270F\u{FE0F} Type your answer:",
    });
    return;
  }

  // Multi-select "Done"
  if (data === "qa_done" && pending.isMulti) {
    const answer =
      [...pending.selected]
        .map((i) => pending.question.options[i].label)
        .join(", ") || pending.question.options[0]?.label || "";
    await editMessage(chatId, msgId, `\u2705 <b>${escapeHtml(answer)}</b>`);
    pending.resolve(answer);
    return;
  }

  // Option selected
  if (data.startsWith("qa_")) {
    const idx = parseInt(data.slice(3));
    const option = pending.question.options[idx];
    if (!option) return;

    if (pending.isMulti) {
      // Toggle selection, update keyboard
      if (pending.selected.has(idx)) pending.selected.delete(idx);
      else pending.selected.add(idx);
      await apiCall("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: pending.buildKeyboard() },
      });
    } else {
      // Single select — done
      await editMessage(chatId, msgId, `\u2705 <b>${escapeHtml(option.label)}</b>`);
      pending.resolve(option.label);
    }
  }
}

// ── Message Queue ──────────────────────────────────────────────────
const messageQueue = [];
let processing = false;
let currentAbortController = null;

function enqueue(msg) {
  messageQueue.push(msg);
  if (!processing) processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error("Queue error:", err);
    }
  }
  processing = false;
}

// ── Claude Code Integration ────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const senderName = msg.from?.first_name || "User";
  const text = msg.text || "";
  const prompt = `[${senderName}]: ${text}`;

  const sent = await sendMessage(chatId, "\u23F3 Processing...");
  if (!sent) return;
  const msgId = sent.message_id;

  const typingInterval = setInterval(() => sendTyping(chatId), 5000);
  sendTyping(chatId);

  let responseText = "";
  let toolLines = [];
  let lastUpdate = 0;
  let finished = false;

  const controller = new AbortController();
  currentAbortController = controller;

  function buildOutput(costLine) {
    let out = "";
    if (toolLines.length > 0) {
      const shown = toolLines.slice(-10);
      out += shown.map((l) => escapeHtml(l)).join("\n") + "\n\n";
    }
    out += responseText ? mdToHtml(responseText) : "...";
    if (costLine) out += `\n\n\u{1F4B0} ${escapeHtml(costLine)}`;
    return out;
  }

  async function throttledUpdate() {
    const now = Date.now();
    if (now - lastUpdate < 3000) return;
    lastUpdate = now;
    const html = buildOutput();
    const truncated = html.length > 4000 ? "..." + html.slice(-3900) : html;
    await editMessage(chatId, msgId, truncated);
  }

  try {
    const conversation = query({
      prompt,
      options: {
        model: MODEL,
        cwd: CWD,
        ...(state.sessionId ? { resume: state.sessionId } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController: controller,
        canUseTool: async (toolName, input) => {
          if (toolName === "AskUserQuestion" && input.questions) {
            const answers = {};
            for (const q of input.questions) {
              const answer = await waitForTelegramAnswer(chatId, q);
              answers[q.question] = answer;
            }
            return { behavior: "allow", updatedInput: { ...input, answers } };
          }
          return { behavior: "allow" };
        },
      },
    });

    for await (const event of conversation) {
      if (controller.signal.aborted) break;

      if (event.type === "system" && event.subtype === "init") {
        state.sessionId = event.session_id;
        saveState();
      }

      if (event.type === "assistant") {
        for (const block of event.message?.content || []) {
          if (block.type === "text") {
            responseText += block.text;
          } else if (block.type === "tool_use") {
            toolLines.push(formatToolUse(block));
          }
        }
        await throttledUpdate();
      }

      if (event.type === "result") {
        const cost = event.total_cost_usd || 0;
        state.sessionCost += cost;
        state.totalCost += cost;
        state.sessionId = event.session_id;
        saveState();

        finished = true;
        const costLine = `Cost: $${cost.toFixed(4)} (session: $${state.sessionCost.toFixed(4)} | total: $${state.totalCost.toFixed(4)})`;
        const finalHtml = buildOutput(costLine);
        const parts = splitMessage(finalHtml);

        await editMessage(chatId, msgId, parts[0]);
        for (let i = 1; i < parts.length; i++) {
          await sendMessage(chatId, parts[i]);
        }
      }
    }

    if (!finished) {
      const html = buildOutput("\u26A0\uFE0F Interrupted");
      await editMessage(chatId, msgId, html.slice(0, 4096));
    }
  } catch (err) {
    console.error("Claude Code error:", err);
    await handleCrash(chatId, msgId, err);
  } finally {
    clearInterval(typingInterval);
    currentAbortController = null;
  }
}

// ── Self-Healing ───────────────────────────────────────────────────
async function handleCrash(chatId, msgId, error) {
  const now = Date.now();
  state.crashLog.push(now);
  state.crashLog = state.crashLog.filter((t) => now - t < 300000);
  saveState();

  const errMsg = error?.message || String(error);
  await editMessage(
    chatId,
    msgId,
    `\u274C Error: ${escapeHtml(errMsg.slice(0, 500))}`
  );

  if (state.crashLog.length >= 3) {
    await sendMessage(
      chatId,
      "\u{1F6A8} 3+ crashes in 5 minutes. Stopping auto-recovery. Manual intervention needed."
    );
    return;
  }

  state.sessionId = null;
  saveState();

  await sendMessage(chatId, "\u{1F504} Starting recovery...");
  const sent = await sendMessage(chatId, "\u23F3 Diagnosing...");
  if (!sent) return;

  try {
    const conversation = query({
      prompt: `The previous Claude Code session crashed with this error: ${errMsg}. Please diagnose and fix the issue.`,
      options: {
        model: MODEL,
        cwd: CWD,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });

    let recoveryText = "";
    for await (const event of conversation) {
      if (event.type === "system" && event.subtype === "init") {
        state.sessionId = event.session_id;
        saveState();
      }
      if (event.type === "assistant") {
        for (const block of event.message?.content || []) {
          if (block.type === "text") recoveryText += block.text;
        }
      }
      if (event.type === "result") {
        const cost = event.total_cost_usd || 0;
        state.sessionCost += cost;
        state.totalCost += cost;
        state.sessionId = event.session_id;
        saveState();
      }
    }

    const html = mdToHtml(recoveryText || "Recovery completed.");
    const parts = splitMessage(html);
    await editMessage(chatId, sent.message_id, parts[0]);
    for (let i = 1; i < parts.length; i++) {
      await sendMessage(chatId, parts[i]);
    }
  } catch (recoveryErr) {
    console.error("Recovery failed:", recoveryErr);
    await editMessage(
      chatId,
      sent.message_id,
      `\u274C Recovery failed: ${escapeHtml(String(recoveryErr).slice(0, 200))}`
    );
  }
}

// ── Commands ───────────────────────────────────────────────────────
async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const cmd = msg.text.split(/\s/)[0].toLowerCase().replace(/@\w+$/, "");

  switch (cmd) {
    case "/new":
      if (currentAbortController) currentAbortController.abort();
      state.sessionId = null;
      state.sessionCost = 0;
      saveState();
      await sendMessage(chatId, "\u{1F504} Session reset. Starting fresh.");
      break;

    case "/stop":
      if (currentAbortController) {
        currentAbortController.abort();
        await sendMessage(chatId, "\u23F9\uFE0F Stopped current operation.");
      } else {
        await sendMessage(chatId, "Nothing is running.");
      }
      break;

    case "/cost":
      await sendMessage(
        chatId,
        `\u{1F4B0} Session: $${state.sessionCost.toFixed(4)} | All-time: $${state.totalCost.toFixed(4)}`
      );
      break;

    default:
      enqueue(msg);
  }
}

// ── Polling ────────────────────────────────────────────────────────
const startTime = Math.floor(Date.now() / 1000);

async function poll() {
  console.log(`Bot started. Polling for updates...`);
  console.log(`Model: ${MODEL} | CWD: ${CWD} | Chat: ${GROUP_CHAT_ID}`);

  while (true) {
    try {
      const updates = await apiCall("getUpdates", {
        offset: state.offset || undefined,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      if (updates && updates.length > 0) {
        for (const update of updates) {
          state.offset = update.update_id + 1;

          // ── Handle callback queries (inline keyboard taps) ──
          if (update.callback_query) {
            handleCallbackQuery(update.callback_query).catch((e) =>
              console.error("Callback query error:", e)
            );
            continue;
          }

          const msg = update.message;
          if (!msg || !msg.text) continue;

          // Skip stale messages from before this boot
          if (msg.date < startTime - STALE_THRESHOLD_S) {
            console.log(
              `Skipping stale: [${msg.from?.first_name}] ${msg.text.slice(0, 40)}`
            );
            continue;
          }

          const userId = msg.from?.id;
          const chatId = msg.chat.id;

          if (GROUP_CHAT_ID && chatId !== GROUP_CHAT_ID) continue;
          if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(userId)) continue;

          // ── Check if this is a reply to a pending question ──
          if (msg.reply_to_message) {
            const replyToId = msg.reply_to_message.message_id;
            const pending = pendingAnswers.get(replyToId);
            if (pending) {
              await editMessage(
                chatId,
                replyToId,
                `\u2705 <b>${escapeHtml(msg.text)}</b>`
              );
              pending.resolve(msg.text);
              continue;
            }
          }

          // ── Check if waiting for free-text "Other" input ──
          if (pendingTextInput && chatId === pendingTextInput.chatId) {
            await editMessage(
              chatId,
              pendingTextInput.questionMsgId,
              `\u2705 <b>${escapeHtml(msg.text)}</b>`
            );
            pendingTextInput.resolve(msg.text);
            pendingTextInput = null;
            continue;
          }

          console.log(`[${msg.from?.first_name}] ${msg.text.slice(0, 80)}`);

          if (msg.text.startsWith("/")) {
            handleCommand(msg).catch((e) =>
              console.error("Command error:", e)
            );
          } else {
            enqueue(msg);
          }
        }
        saveState();
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────
loadState();
poll();
