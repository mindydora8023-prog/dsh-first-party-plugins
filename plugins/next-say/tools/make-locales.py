"""Generate the ASCII-escaped locale dictionaries for next-say's client half.

The workspace convention forbids non-ASCII in executable .js sources (a
PowerShell round-trip here once corrupted such a file into a syntax error), so
Chinese UI copy is emitted as \\u escapes. Writing the source copy in Python and
emitting escapes mechanically keeps the two dictionaries in key parity and
avoids hand-escaping mistakes.

Run:  python tools/make-locales.py --write
      python tools/make-locales.py --check
      python tools/make-locales.py  (stdout only)
"""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "lib" / "locales.js"

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
    "manualPredict": "预测下一句",
    "manualHint": "点击预测下一句；建议只填入草稿，不会发送。",
    "manualReady": "建议已显示在输入框；Tab 填入整句，Ctrl+右方向键只填下一个词，都不会发送。",
    "manualPaused": "预测已暂停，暂停结束后可继续。",
    "manualInputBusy": "输入框正在处理消息或命令，请稍候。",
    "manualRunning": "等待当前回合结束后再预测。",
    "manualDraft": "清空草稿后可预测下一句；输入时使用历史补全。",
    "manualNoResult": "这次没有生成新的建议，可以再次预测。",
    "manualNoRoute": "先在会话里完成一轮，或在设置中指定预测模型。",
    "manualDisabled": "下一句建议已关闭。",
    "noHistory": "还没有可参考的对话，请先发送一条消息。",
    "timeout": "预测超时，可以手动重试。",
    "manualBusy": "预测中…",
    "paused": "已暂停",
    "pausedHint": "预测已暂停，到点自动恢复。",
    "empty": "暂无建议",
    "failed": "没预测出来",
    "hintTab": "Tab 填入整句；Ctrl+右方向键只填下一个词；都不会发送",
    "tabAccept": "Tab 采纳",
    "settingsNav": "下一句建议",
    "settingsTitle": "下一句建议",
    "settingsIntro": "回合结束后预测你的下一句话；输入草稿时用本地历史做前缀补全。打字仍是预测开头时灰字会跟着走。Tab 填入整句，Ctrl+右方向键只填下一个词，都不会自动发送。",
    "settingsEnabled": "启用建议",
    "settingsEnabledHint": "关闭后既不再预测，也不再显示历史补全。",
    "settingsMode": "预测时机",
    "settingsModeHint": "自动：每轮回答结束后预测，失败最多重试一次。手动：点击输入框下方的「预测下一句」才调用模型。每次调用都可能计费。",
    "settingsModeAuto": "自动",
    "settingsModeManual": "仅手动",
    "settingsMaxChars": "建议字数上限",
    "settingsMaxCharsHint": "建议最长多少个字符。中文按字，英文按字符。",
    "settingsContextMessages": "参考消息条数",
    "settingsContextMessagesHint": "预测时最多读取最近多少条消息。",
    "settingsContextChars": "上下文预算",
    "settingsContextCharsHint": "这些消息合计最多多少个字符。",
    "settingsTimeout": "超时（毫秒）",
    "settingsTimeoutHint": "超时后停止等待并丢弃迟到结果。自动模式最多重试一次；手动模式显示原因，由你再次点击。",
    "settingsHistory": "历史前缀补全",
    "settingsHistoryHint": "输入时用本会话已发过的消息做灰字补全，不产生任何模型调用。",
    "settingsHistoryMinChars": "最少输入字数",
    "settingsHistoryMinCharsHint": "输入到这么多个字才开始补全。",
    "settingsProvider": "预测服务商",
    "settingsProviderHint": "默认使用当前会话上次调用的模型。要单独指定预测模型，请填写服务商 ID 和模型 ID。",
    "settingsSaveRoute": "保存预测模型",
    "settingsRouteHint": "两项同时留空并保存，即可恢复跟随会话。",
    "settingsRouteIncomplete": "请同时填写或清空服务商和模型。",
    "settingsInherit": "跟随会话",
    "settingsModel": "预测模型",
    "settingsModelHint": "填写要单独用于预测的模型 ID。",
    "settingsPause": "暂停十分钟",
    "settingsPauseHint": "暂停期间不发起任何预测调用，到点自动恢复。",
    "settingsResume": "恢复预测",
    "settingsResumeHint": "当前处于暂停状态，点此立即恢复。",
    "settingsReset": "恢复默认",
    "settingsResetHint": "把所有设置恢复为默认值。",
    "settingsSave": "保存",
    "settingsUnsaved": "有未保存的编辑",
    "settingsUncertain": "保存结果待核对；后续保存已暂停。请重新读取设置后再操作。",
    "settingsReload": "重新读取设置",
    "settingsReloading": "正在读取设置…",
    "settingsEditHint": "数值编辑完成后移开焦点或按 Enter 保存；Esc 撤销。预测服务商和模型使用下方按钮一起保存。",
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
    "manualPredict": "Predict next message",
    "manualHint": "Predict your next message. Suggestions only fill the draft; they never send.",
    "manualReady": "Suggestion shown in the editor. Tab fills all of it; Ctrl/Cmd+Right fills the next word. Neither sends.",
    "manualPaused": "Predictions are paused until the pause expires.",
    "manualInputBusy": "The editor is processing a message or command. Please wait.",
    "manualRunning": "Wait for the current turn to finish before predicting.",
    "manualDraft": "Clear the draft to predict. Typing uses history completion.",
    "manualNoResult": "No new suggestion this time. You can predict again.",
    "manualNoRoute": "Finish a turn in this session or choose a prediction model in settings.",
    "manualDisabled": "Next-say suggestions are disabled.",
    "noHistory": "No conversation to reference yet. Send a message first.",
    "timeout": "The prediction timed out. You can retry manually.",
    "manualBusy": "Predicting…",
    "paused": "Paused",
    "pausedHint": "Predictions are paused and resume automatically.",
    "empty": "No suggestion yet",
    "failed": "Could not predict",
    "hintTab": "Tab fills the whole suggestion; Ctrl/Cmd+Right fills the next word; neither sends",
    "tabAccept": "Tab accept",
    "settingsNav": "Next-say",
    "settingsTitle": "Next-say suggestions",
    "settingsIntro": "Predicts your next message after each finished turn, and completes a draft from local history. Typing a matching prefix keeps the rest visible. Tab fills the whole suggestion; Ctrl/Cmd+Right fills the next word. Neither sends.",
    "settingsEnabled": "Enable suggestions",
    "settingsEnabledHint": "Turning this off stops both model predictions and history completion.",
    "settingsMode": "When to predict",
    "settingsModeHint": "Auto predicts after a finished turn, with at most one retry after failure. Manual calls the model only when you click Predict next message below the editor. Each call may be billed.",
    "settingsModeAuto": "Automatic",
    "settingsModeManual": "Manual only",
    "settingsMaxChars": "Suggestion length",
    "settingsMaxCharsHint": "Longest suggested message, in characters.",
    "settingsContextMessages": "Messages considered",
    "settingsContextMessagesHint": "How many recent messages a prediction may read.",
    "settingsContextChars": "Context budget",
    "settingsContextCharsHint": "Character cap across those messages.",
    "settingsTimeout": "Timeout (ms)",
    "settingsTimeoutHint": "A timeout stops waiting and discards late results. Auto mode retries at most once; manual mode shows the reason and waits for another click.",
    "settingsHistory": "History completion",
    "settingsHistoryHint": "Completes from messages already sent in this conversation. Makes no model call.",
    "settingsHistoryMinChars": "Minimum draft length",
    "settingsHistoryMinCharsHint": "How many characters to type before completion starts.",
    "settingsProvider": "Prediction provider",
    "settingsProviderHint": "Predictions use the model last called in this session. Enter both IDs to choose a separate model.",
    "settingsSaveRoute": "Save prediction model",
    "settingsRouteHint": "Clear both fields and save to follow the session model again.",
    "settingsRouteIncomplete": "Fill in both fields or clear them both.",
    "settingsInherit": "Follow session",
    "settingsModel": "Prediction model",
    "settingsModelHint": "Enter the ID of the model to use for predictions.",
    "settingsPause": "Pause for ten minutes",
    "settingsPauseHint": "No prediction call is made while paused; it resumes automatically.",
    "settingsResume": "Resume predictions",
    "settingsResumeHint": "Predictions are paused right now; press to resume immediately.",
    "settingsReset": "Reset to defaults",
    "settingsResetHint": "Restore every setting to its default value.",
    "settingsSave": "Save",
    "settingsUnsaved": "Unsaved edits",
    "settingsUncertain": "The save outcome needs checking. Further saves are paused; reload the settings before continuing.",
    "settingsReload": "Reload settings",
    "settingsReloading": "Reading settings...",
    "settingsEditHint": "Finish numeric edits by leaving the field or pressing Enter; Escape cancels. Save the prediction provider and model together with the button below.",
    "settingsSaved": "Saved",
    "settingsSaving": "Saving…",
    "settingsFailed": "Could not save",
    "settingsLoadFailed": "Could not read the settings; showing defaults.",
    "costWarning": "Every automatic prediction is a real, billed model call.",
    "never": "Never",
}


def escape(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


def emit(name: str, table: dict) -> str:
    lines = [f"const {name} = {{"]
    for key, value in table.items():
        lines.append(f"  {escape(key)}: {escape(value)},")
    lines.append("};")
    return "\n".join(lines)


def render() -> str:
    zh_only = set(ZH) - set(EN)
    en_only = set(EN) - set(ZH)
    assert not zh_only, f"zh keys missing from en: {sorted(zh_only)}"
    assert not en_only, f"en keys missing from zh: {sorted(en_only)}"
    return "\n".join([
        "/**",
        " * Locale dictionaries for the next-say Client half.",
        " *",
        " * Generated by tools/make-locales.py; do not edit by hand. Chinese copy is",
        " * stored as \\\\u escapes because this workspace keeps executable sources ASCII",
        " * (a PowerShell round-trip once corrupted a UTF-8 .js file beyond repair).",
        " */",
        "",
        emit("zh", ZH),
        "",
        emit("en", EN),
        "",
        "export const LOCALES = { zh, en };",
        f"export const KEY_COUNT = {len(ZH)};",
        "",
    ])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="check lib/locales.js without writing")
    mode.add_argument("--write", action="store_true", help="write lib/locales.js")
    args = parser.parse_args(argv)
    expected = render().encode("ascii")
    if args.check:
        if not OUTPUT.is_file():
            print("lib/locales.js is missing; run python tools/make-locales.py --write", file=sys.stderr)
            return 1
        if OUTPUT.read_bytes() != expected:
            print("STALE lib/locales.js; run python tools/make-locales.py --write", file=sys.stderr)
            return 1
        print("lib/locales.js is up to date")
    elif args.write:
        OUTPUT.write_bytes(expected)
    else:
        # Preserve the historical stdout interface, including pure LF bytes.
        sys.stdout.buffer.write(expected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
