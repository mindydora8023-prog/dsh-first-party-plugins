"""Generate the ASCII-escaped locale dictionaries for next-say's client half.

The workspace convention forbids non-ASCII in executable .js sources (a
PowerShell round-trip here once corrupted such a file into a syntax error), so
Chinese UI copy is emitted as \\u escapes. Writing the source copy in Python and
emitting escapes mechanically keeps the two dictionaries in key parity and
avoids hand-escaping mistakes.

Run:  python tools/make-locales.py > lib/locales.js
"""

import contextlib
import io
import pathlib
import sys

# Keys must stay identical across languages; assert that at the end.
ZH = {
    "title": "下一句建议",
    "idle": "下一句建议",
    "tab": "Tab",
    "accept": "采纳",
    "reroll": "换一条",
    "dismiss": "忽略",
    "thinking": "正在想下一句…",
    "manual": "预测",
    "manualBusy": "预测中…",
    "paused": "已暂停",
    "pausedHint": "预测已暂停，到点自动恢复。",
    "empty": "暂无建议",
    "failed": "没预测出来",
    "hintTab": "Tab 填入草稿，不会发送",
    "tabAccept": "Tab 采纳",
    "settingsNav": "下一句建议",
    "settingsTitle": "下一句建议",
    "settingsIntro": "回合结束后预测你的下一句话；输入草稿时用本地历史做前缀补全。两种建议都只填入草稿，不会自动发送。",
    "settingsEnabled": "启用建议",
    "settingsEnabledHint": "关闭后既不再预测，也不再显示历史补全。",
    "settingsMode": "预测时机",
    "settingsModeHint": "自动：每轮回答结束后预测一次（每次都是真实计费调用）。手动：只在点「预测」时调用。",
    "settingsModeAuto": "自动",
    "settingsModeManual": "仅手动",
    "settingsMaxChars": "建议字数上限",
    "settingsMaxCharsHint": "建议最长多少个字符。中文按字，英文按字符。",
    "settingsContextMessages": "参考消息条数",
    "settingsContextMessagesHint": "预测时最多读取最近多少条消息。",
    "settingsContextChars": "上下文预算",
    "settingsContextCharsHint": "这些消息合计最多多少个字符。",
    "settingsTimeout": "超时（毫秒）",
    "settingsTimeoutHint": "超时后丢弃这一次结果，不显示错误、不自动重试。",
    "settingsHistory": "历史前缀补全",
    "settingsHistoryHint": "输入时用本会话已发过的消息做灰字补全，不产生任何模型调用。",
    "settingsHistoryMinChars": "最少输入字数",
    "settingsHistoryMinCharsHint": "输入到这么多个字才开始补全。",
    "settingsProvider": "预测模型",
    "settingsProviderHint": "留空则跟随当前会话使用的模型。",
    "settingsInherit": "跟随会话",
    "settingsModel": "模型",
    "settingsModelHint": "只在需要换到更便宜的模型时设置。",
    "settingsPause": "暂停十分钟",
    "settingsPauseHint": "暂停期间不发起任何预测调用，到点自动恢复。",
    "settingsResume": "恢复预测",
    "settingsResumeHint": "当前处于暂停状态，点此立即恢复。",
    "settingsReset": "恢复默认",
    "settingsResetHint": "把所有设置恢复为默认值。",
    "settingsSave": "保存",
    "settingsSaved": "已保存",
    "settingsSaving": "正在保存…",
    "settingsFailed": "保存失败",
    "settingsLoadFailed": "读取设置失败，当前显示的是默认值。",
    "costWarning": "每次自动预测都是一次真实计费的模型调用。",
    "never": "从不",
}

EN = {
    "title": "Next-say suggestions",
    "idle": "Next-say",
    "tab": "Tab",
    "accept": "Accept",
    "reroll": "Another",
    "dismiss": "Dismiss",
    "thinking": "Thinking of your next message…",
    "manual": "Predict",
    "manualBusy": "Predicting…",
    "paused": "Paused",
    "pausedHint": "Predictions are paused and resume automatically.",
    "empty": "No suggestion yet",
    "failed": "Could not predict",
    "hintTab": "Tab fills the draft; it never sends",
    "tabAccept": "Tab accept",
    "settingsNav": "Next-say",
    "settingsTitle": "Next-say suggestions",
    "settingsIntro": "Predicts your next message after each finished turn, and completes a draft from local history. Neither is sent for you: Tab only fills the draft.",
    "settingsEnabled": "Enable suggestions",
    "settingsEnabledHint": "Turning this off stops both model predictions and history completion.",
    "settingsMode": "When to predict",
    "settingsModeHint": "Auto: once after every finished turn (each one is a real billed call). Manual: only when you press Predict.",
    "settingsModeAuto": "Automatic",
    "settingsModeManual": "Manual only",
    "settingsMaxChars": "Suggestion length",
    "settingsMaxCharsHint": "Longest suggested message, in characters.",
    "settingsContextMessages": "Messages considered",
    "settingsContextMessagesHint": "How many recent messages a prediction may read.",
    "settingsContextChars": "Context budget",
    "settingsContextCharsHint": "Character cap across those messages.",
    "settingsTimeout": "Timeout (ms)",
    "settingsTimeoutHint": "A timeout drops that result silently: no error, no automatic retry.",
    "settingsHistory": "History completion",
    "settingsHistoryHint": "Completes from messages already sent in this conversation. Makes no model call.",
    "settingsHistoryMinChars": "Minimum draft length",
    "settingsHistoryMinCharsHint": "How many characters to type before completion starts.",
    "settingsProvider": "Prediction model",
    "settingsProviderHint": "Leave empty to follow the model the current session uses.",
    "settingsInherit": "Follow the session",
    "settingsModel": "Model",
    "settingsModelHint": "Set this only to move predictions to a cheaper model.",
    "settingsPause": "Pause for ten minutes",
    "settingsPauseHint": "No prediction call is made while paused; it resumes automatically.",
    "settingsResume": "Resume predictions",
    "settingsResumeHint": "Predictions are paused right now; press to resume immediately.",
    "settingsReset": "Reset to defaults",
    "settingsResetHint": "Restore every setting to its default value.",
    "settingsSave": "Save",
    "settingsSaved": "Saved",
    "settingsSaving": "Saving…",
    "settingsFailed": "Could not save",
    "settingsLoadFailed": "Could not read the settings; showing defaults.",
    "costWarning": "Every automatic prediction is a real, billed model call.",
    "never": "Never",
}


def escape(value: str) -> str:
    out = []
    for char in value:
        code = ord(char)
        if code < 0x20:
            out.append("\\u%04x" % code)
        elif code < 0x7F:
            if char in "\\'":
                out.append("\\" + char)
            else:
                out.append(char)
        else:
            out.append("\\u%04x" % code)
    return '"' + "".join(out) + '"'


def emit(name: str, table: dict) -> str:
    lines = [f"const {name} = {{"]
    for key, value in table.items():
        lines.append(f"  {key}: {escape(value)},")
    lines.append("};")
    return "\n".join(lines)


def emit_all() -> None:
    zh_only = set(ZH) - set(EN)
    en_only = set(EN) - set(ZH)
    assert not zh_only, f"zh keys missing from en: {sorted(zh_only)}"
    assert not en_only, f"en keys missing from zh: {sorted(en_only)}"

    print("/**")
    print(" * Locale dictionaries for the next-say Client half.")
    print(" *")
    print(" * Generated by tools/make-locales.py; do not edit by hand. Chinese copy is")
    print(" * stored as \\\\u escapes because this workspace keeps executable sources ASCII")
    print(" * (a PowerShell round-trip once corrupted a UTF-8 .js file beyond repair).")
    print(" */")
    print()
    print(emit("zh", ZH))
    print()
    print(emit("en", EN))
    print()
    print(f"export const LOCALES = {{ zh, en }};")
    print(f"export const KEY_COUNT = {len(ZH)};")


def render() -> str:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        emit_all()
    return output.getvalue()


def main(argv: list[str]) -> int:
    output = pathlib.Path(__file__).resolve().parent.parent / "lib" / "locales.js"
    expected = render().encode("utf-8")
    if "--check" in argv:
        if not output.is_file() or output.read_bytes() != expected:
            print("lib/locales.js is STALE; run python tools/make-locales.py --write", file=sys.stderr)
            return 1
        print("lib/locales.js is up to date")
    elif "--write" in argv:
        output.write_bytes(expected)
        print("built lib/locales.js")
    else:
        sys.stdout.write(expected.decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
