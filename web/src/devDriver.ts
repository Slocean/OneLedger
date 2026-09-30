import { getToken } from "./api";

/**
 * 开发验收 driver：仅当实例 config.devUi = true 且前端构建时设置 ONELEDGER_DEV_DRIVER=1
 * 才会存在（B-08：正式构建完全不含本模块）。轮询 /api/dev/ui/poll 取 DOM 级命令
 * （点击/输入/读取/等待），在本窗口内执行后回传结果；没有任意 JS 执行能力。
 * 所有请求带 admin token；点击期间如页面使用原生 confirm/alert，仅在这一次调用内
 * 模拟「用户选择」（confirm 缺省=取消，confirm:true=同意）并在调用后立即恢复，
 * 绝不永久改写全局 confirm/alert。
 */

interface DevCommand {
  kind: "click" | "fill" | "read" | "waitText";
  selector?: string;
  text?: string;
  value?: string;
  nth?: number;
  timeoutMs?: number;
  /** 点击语义（B-08/第六轮）：缺省 false=取消——原生 confirm 一律按「取消」处理；
   *  只有显式 confirm:true 才在这一次同步点击内模拟「同意」并立即恢复。 */
  confirm?: boolean;
}

/** 当前是否有原生对话框替换仍处于挂起状态；正常情况下点击 finally 恢复后恒为 false。 */
let dialogOverrideActive = false;

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function findBySelector(selector: string, nth = 0): Element | undefined {
  const all = [...document.querySelectorAll(selector)].filter(visible);
  return all[nth] ?? all[0];
}

function findByText(text: string, nth = 0): Element | undefined {
  const targets = [...document.querySelectorAll("button, a, summary, label, [role='button'], input[type='checkbox'], input[type='submit']")].filter(visible);
  const matches = targets.filter((el) => {
    const label = (el.textContent ?? "").trim() || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "";
    return label.includes(text);
  });
  return matches[nth] ?? matches[0];
}

function clickElement(el: Element, confirm: boolean): void {
  el.scrollIntoView({ block: "center" });
  // B-08/第六轮：点击期间页面若调用原生 confirm/alert，仅在这一次同步点击内模拟
  // 「用户选择」并在 finally 恢复原实现——confirm:false（缺省）=取消（confirm 返回 false），
  // 只有显式 confirm:true 才模拟「同意」（返回 true）。不模拟会让 WebView2 原生对话框
  // 阻塞 driver 的同步点击；严禁永久改写 window.confirm / window.alert。
  const w = window as unknown as { confirm?: () => boolean; alert?: (msg?: string) => void };
  const originalConfirm = w.confirm;
  const originalAlert = w.alert;
  const restoreNow = (): void => {
    if (originalConfirm === undefined) delete w.confirm;
    else w.confirm = originalConfirm;
    if (originalAlert === undefined) delete w.alert;
    else w.alert = originalAlert;
    dialogOverrideActive = false;
  };
  w.confirm = () => confirm;
  w.alert = () => undefined;
  dialogOverrideActive = true;
  try {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      el.click();
      return;
    }
    (el as HTMLElement).click();
  } finally {
    restoreNow();
  }
}

function fillElement(el: Element, value: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

/** 结构化页面快照：比 OCR 更精确的窗口内状态证据。 */
function readPage(): Record<string, unknown> {
  const grab = (selector: string) =>
    [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((el) => ({
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        tag: el.tagName.toLowerCase(),
        checked: el instanceof HTMLInputElement ? el.checked : undefined,
        disabled: el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.disabled : undefined,
        value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value.slice(0, 500) : undefined,
        classes: el.className && typeof el.className === "string" ? el.className : undefined,
      }))
      .filter((item) => item.text || item.value);
  return {
    url: location.href,
    title: document.title,
    headings: grab("h1, h2, h3"),
    buttons: grab("button"),
    inputs: grab("input, textarea, select"),
    checkboxes: grab("input[type='checkbox']"),
    notes: grab("p.ok, p.error, .banner, [role='alert'], p.muted"),
    items: grab("article.item h3"),
    tables: grab("table"),
    bodyTextSnippet: document.body.innerText.replace(/\s+/g, " ").slice(0, 4000),
    // 固定断言（代替 eval）：原生对话框替换不处于挂起状态、原实现存在且未被永久改写
    dialogPristine: !dialogOverrideActive,
    nativeDialogsPresent: typeof (window as unknown as { confirm?: unknown }).confirm === "function" && typeof window.alert === "function",
  };
}

async function execute(command: DevCommand): Promise<Record<string, unknown>> {
  switch (command.kind) {
    case "click": {
      const el = command.selector ? findBySelector(command.selector, command.nth) : findByText(command.text ?? "", command.nth);
      if (!el) return { ok: false, error: `未找到可点击元素：${command.selector ?? command.text}` };
      const confirm = command.confirm === true;
      clickElement(el, confirm);
      return {
        ok: true,
        clicked: ((el.textContent ?? "").trim() || (el as HTMLInputElement).value).slice(0, 120),
        confirm,
        dialogPristine: !dialogOverrideActive,
      };
    }
    case "fill": {
      const el = command.selector ? findBySelector(command.selector, command.nth) : findByText(command.text ?? "", command.nth);
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        return { ok: false, error: `目标不是输入元素：${command.selector ?? command.text}` };
      }
      el.focus();
      fillElement(el, command.value ?? "");
      return { ok: true, filled: command.value ?? "" };
    }
    case "read":
      return { ok: true, page: readPage() };
    case "waitText": {
      const deadline = Date.now() + (command.timeoutMs ?? 5000);
      while (Date.now() < deadline) {
        if (document.body.innerText.includes(command.text ?? "")) {
          return { ok: true, found: command.text };
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return { ok: false, error: `等待文本超时：${command.text}`, page: readPage() };
    }
    default:
      return { ok: false, error: `未知命令类型` };
  }
}

export function startDevDriver(): void {
  let disabled = false; // 仅 404（dev 关闭）永久停用；401（未登录）放慢轮询等登录
  const tick = async (): Promise<number> => {
    try {
      const res = await fetch("/api/dev/ui/poll", { headers: { "x-admin-token": getToken() } });
      if (res.status === 404) {
        disabled = true;
        return 0;
      }
      if (res.status === 401) return 2000; // 未登录：放慢，等 token 就绪
      const payload = (await res.json()) as { commandId?: number; command?: DevCommand };
      if (payload.commandId && payload.command) {
        let result: Record<string, unknown>;
        try {
          result = await execute(payload.command);
        } catch (cause) {
          result = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
        await fetch("/api/dev/ui/result", {
          method: "POST",
          headers: { "x-admin-token": getToken(), "content-type": "application/json" },
          body: JSON.stringify({ commandId: payload.commandId, ...result }),
        });
      }
      return 250;
    } catch {
      return 1000; // 网络错误：稍后重试
    }
  };
  const loop = () => {
    if (disabled) return;
    void tick().then((delay) => {
      if (!disabled) window.setTimeout(loop, delay);
    });
  };
  loop();
}
