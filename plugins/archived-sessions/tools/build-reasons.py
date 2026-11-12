"""Generate lib/reasons.js: the archived-sessions refusal catalog.

The host half used to carry ~700 non-ASCII characters inline, which violates the
workspace rule that executable sources stay ASCII (this machine's PowerShell reads
UTF-8 as CP936 and writes it back as UTF-8, so Chinese in a .js file can become
mojibake or a syntax error after one accidental round-trip).

These strings are shown to the user in Settings when a delete is refused, so they
must not become English. Instead the readable copy lives HERE, in Python, and the
generated module carries it as \\uXXXX escapes -- same approach as
next-say/tools/make-locales.py. Nobody hand-escapes a string.

Run:  python tools/build-reasons.py
      python tools/build-reasons.py --check     verify lib/reasons.js is current
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "lib" / "reasons.js"

#: key -> Simplified Chinese. Placeholders use {name} and are filled by reason().
ZH = {
    # --- child / cascade blockers -------------------------------------------
    "child-not-subagent": "是独立分支会话，不会连带删除；请单独归档并删除它",
    "child-archived": "这个子会话本身也在归档列表里，请先单独删除它",
    "child-in-workspace": "这个子会话挂在某个工作区里，不属于隐藏子 Agent；请单独归档并删除它",
    "child-live": "这个子会话仍被宿主占用，请重启 Harness 后重试",
    "orphan-archived": "这个子会话在归档列表里，请直接删除那条归档记录",
    "orphan-in-workspace": "这个子会话挂在某个工作区里，不属于隐藏子 Agent",
    # --- composite refusal messages -----------------------------------------
    "refuse-children": "仍有隐藏子 Agent 无法随此会话一起删除，未执行删除。\n{lines}\n请先处理这些子会话后重试。",
    "refuse-referenced": "仍有子会话或分支引用此会话（{count} 个），未执行删除。\n{lines}\n若确认这些是隐藏子 Agent，请在删除确认时选择一并清理。",
    "refuse-orphans": "有孤儿会话不能清理，未执行任何删除。\n{lines}\n请先处理这些子会话后重试。",
    "line-child": "子 Agent {id}：{reason}",
    "line-child-plain": "子 Agent: {id}",
    "line-orphan": "{id}（父会话 {missingParent} 已不存在）：{reason}",
    # --- storage / lease guards ---------------------------------------------
    "storage-invalid": "存储目录校验失败，未执行删除。",
    "session-live": "该会话仍被宿主占用，请重启 Harness 后再删除。",
    "session-activity": "该会话仍有运行中的任务，无法删除。",
    "delete-incomplete": "删除未完成，日志已保留；工作区元数据可能需要修复，请检查宿主日志。",
    "quarantine-failed": "{id}: 会话已移除，但隔离日志清理失败，请检查宿主日志。",
    "not-archived": "只能删除已归档会话。",
    "backend-unsupported": "当前存储后端不支持安全删除。",
    "cascade-mismatch": "待删除的隐藏子 Agent 与预检结果不一致（可能刚新增了子会话），请刷新后重新确认。",
    "orphans-stale": "这些会话已不再是孤儿（可能刚有了父会话），未执行删除：\n{lines}\n请刷新后重试。",
    # --- request validation --------------------------------------------------
    "body-too-large": "请求过大。",
    "body-malformed": "请求格式错误。",
    "delete-in-progress": "会话正在删除，暂时无法打开。",
    "untrusted-origin": "请从已登录的 Harness 页面操作。",
    "unsupported-request": "不支持的请求。",
    "ids-invalid": "会话 ID 列表无效。",
    "id-invalid": "会话 ID 无效，请刷新会话列表后重试。",
    "busy": "此会话正在处理，请勿重复操作。",
    "action-invalid": "会话操作类型无效，请刷新页面后重试。",
    "cleanup-config-invalid": "自动清理设置无效：保留天数需为 1 到 3650 的整数。",
    "internal": "操作失败，存储可能被占用；请刷新后重试。",
    "delete-timeout": "删除超过 {seconds} 秒未完成，已停止等待。该操作可能已部分执行，请刷新后先核对，不要直接重试。",
}

#: The same keys in English, used when DSH_LOCALE is not a Chinese locale.
EN = {
    "child-not-subagent": "is an independent branch session and is not deleted with this one; archive and delete it separately",
    "child-archived": "is itself in the archive list; delete that entry first",
    "child-in-workspace": "belongs to a workspace, so it is not a hidden sub-agent; archive and delete it separately",
    "child-live": "is still held by the host; restart Harness and try again",
    "orphan-archived": "is in the archive list; delete that archive entry instead",
    "orphan-in-workspace": "belongs to a workspace, so it is not a hidden sub-agent",
    "refuse-children": "Hidden sub-agents cannot be removed with this session, so nothing was deleted.\n{lines}\nResolve them first, then retry.",
    "refuse-referenced": "{count} child session(s) or branch(es) still reference this session, so nothing was deleted.\n{lines}\nIf these are hidden sub-agents, choose to clean them up in the confirmation.",
    "refuse-orphans": "Some orphans cannot be cleaned up, so nothing was deleted.\n{lines}\nResolve them first, then retry.",
    "line-child": "Sub-agent {id}: {reason}",
    "line-child-plain": "Sub-agent: {id}",
    "line-orphan": "{id} (parent {missingParent} no longer exists): {reason}",
    "storage-invalid": "The storage directory failed validation; nothing was deleted.",
    "session-live": "The session is still held by the host; restart Harness before deleting it.",
    "session-activity": "The session still has running work, so it cannot be deleted.",
    "delete-incomplete": "The delete did not finish; the logs were kept. Workspace metadata may need repair; check the host log.",
    "quarantine-failed": "{id}: the session was removed, but clearing its quarantined logs failed; check the host log.",
    "not-archived": "Only archived sessions can be deleted.",
    "backend-unsupported": "This storage backend does not support safe deletion.",
    "cascade-mismatch": "The hidden sub-agents to delete no longer match the pre-check (a new child may have appeared); refresh and confirm again.",
    "orphans-stale": "These sessions are no longer orphans (a parent may have appeared), so nothing was deleted:\n{lines}\nRefresh and retry.",
    "body-too-large": "The request is too large.",
    "body-malformed": "The request body is not valid JSON.",
    "delete-in-progress": "The session is being deleted and cannot be opened right now.",
    "untrusted-origin": "Use the signed-in Harness page for this action.",
    "unsupported-request": "Unsupported request.",
    "ids-invalid": "The session id list is invalid.",
    "id-invalid": "The session id is invalid; refresh the session list and retry.",
    "busy": "This session is already being processed; do not repeat the action.",
    "action-invalid": "Unknown session action; refresh the page and retry.",
    "cleanup-config-invalid": "Invalid automatic-cleanup settings: keep days must be an integer from 1 to 3650.",
    "internal": "The operation failed; storage may be busy. Refresh and retry.",
    "delete-timeout": "The delete did not finish within {seconds}s, so waiting stopped. The operation may be partly applied: refresh and check before retrying.",
}


def escape(value: str) -> str:
    """Emit a JSON-ish double-quoted literal containing only ASCII."""
    out = []
    for char in value:
        code = ord(char)
        if char == "\n":
            out.append("\\n")
        elif char == "\\":
            out.append("\\\\")
        elif char == '"':
            out.append('\\"')
        elif 0x20 <= code < 0x7F:
            out.append(char)
        elif code <= 0xFFFF:
            out.append("\\u%04x" % code)
        else:
            # Keep the emitter total rather than silently mangling astral chars.
            high, low = divmod(code - 0x10000, 0x400)
            out.append("\\u%04x\\u%04x" % (0xD800 + high, 0xDC00 + low))
    return '"' + "".join(out) + '"'


def table(name: str, mapping: dict) -> str:
    lines = [f"const {name} = {{"]
    for key, value in mapping.items():
        lines.append(f"  {escape(key)}: {escape(value)},")
    lines.append("};")
    return "\n".join(lines)


def render() -> str:
    zh_only = set(ZH) - set(EN)
    en_only = set(EN) - set(ZH)
    if zh_only:
        raise SystemExit(f"zh keys missing from en: {sorted(zh_only)}")
    if en_only:
        raise SystemExit(f"en keys missing from zh: {sorted(en_only)}")

    header = '''/**
 * User-facing refusal reasons for the archived-sessions host half.
 *
 * GENERATED by tools/build-reasons.py -- do not edit by hand.
 *
 * The host used to carry these strings inline in lib/index.js, which put ~700
 * non-ASCII characters into an executable source. The workspace encoding rule
 * forbids that (a PowerShell round-trip can turn UTF-8 Chinese into mojibake or a
 * syntax error), but these strings are shown to the user in Settings, so making
 * them English would be a regression. The catalog therefore lives in the Python
 * generator and reaches this file as \\uXXXX escapes: ASCII on disk, Chinese on
 * screen.
 *
 * Reason: read the key, not the text. Use reason(key) or reason(key, params).
 */'''
    return "\n\n".join([
        header,
        table("ZH", ZH),
        table("EN", EN),
        """/**
 * Look up a user-facing reason.
 *
 * Placeholders use {name} and are filled from `params`. An unknown key returns
 * the key itself, so a missing translation shows up as a visible identifier
 * instead of throwing during a delete.
 *
 * @param {string} key catalog key.
 * @param {object} [params] placeholder values.
 * @returns {string} the user-facing text.
 */
export function reason(key, params = {}) {
  const table = activeDictionary()
  const text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
  return String(text).replace(/\\{([A-Za-z][A-Za-z0-9]*)\\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/**
 * The active dictionary.
 *
 * This plugin half has no locale service, so the choice is made from DSH_LOCALE:
 * `zh`, `zh-*` and unset mean Chinese (this machine's default); anything else
 * falls back to English.
 */
function activeDictionary() {
  const raw = String(process.env['DSH_LOCALE'] ?? 'zh').toLowerCase()
  return raw === 'zh' || raw.startsWith('zh-') ? ZH : EN
}

export { ZH, EN }""",
    ]) + "\n"


def main() -> int:
    rendered = render()
    if "--check" in sys.argv:
        if not OUTPUT.is_file():
            print(f"missing {OUTPUT}; run tools/build-reasons.py", file=sys.stderr)
            return 1
        if OUTPUT.read_text(encoding="utf-8") == rendered:
            print(f"{OUTPUT.relative_to(ROOT)} is up to date")
            return 0
        print(f"{OUTPUT.relative_to(ROOT)} is STALE; run tools/build-reasons.py", file=sys.stderr)
        return 1
    OUTPUT.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"built {OUTPUT.relative_to(ROOT)} ({len(rendered)} bytes, {len(ZH)} keys)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
