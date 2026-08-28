import { fetchHistory, resetAgent, runAgent } from "../api.js";
import { getController } from "../controller.js";
import { getState, opsSinceSession, reportError, setState, useUiState, type ChatMessage } from "../store.js";
import { Composer } from "./composer.js";
import { HistoryDrawer } from "./history-drawer.js";
import { OpsList } from "./ops-list.js";

export function ChatPanel() {
  const s = useUiState();
  const sessionOps = opsSinceSession(s);

  const openHistory = async (): Promise<void> => {
    const docId = getState().docId;
    if (!docId) return;
    setState({ historyOpen: true });
    try {
      setState({ history: await fetchHistory(docId) });
    } catch (e) {
      reportError("加载历史失败", e);
    }
  };

  const newSession = async (): Promise<void> => {
    const docId = getState().docId;
    // "会话" means one thing in this panel: the transcript AND the op counter
    // above it must start over together. Clearing only `chat` left the header
    // reading "N ops · 本次会话" over an empty transcript.
    setState({ chat: [], sessionBaseVersion: getState().version });
    if (!docId) return;
    try {
      await resetAgent(docId);
    } catch (e) {
      reportError("重置会话失败", e);
    }
  };

  const send = async (text: string): Promise<void> => {
    const { docId, chatBusy, version } = getState();
    if (!docId || chatBusy) return;
    const pending: ChatMessage = { role: "agent", text: "thinking…", pending: true };
    setState({ chatBusy: true, chat: [...getState().chat, { role: "user", text }, pending] });
    try {
      const reply = await runAgent(docId, text);
      // The agent mutated the document server-side, out from under this tab:
      // reconcile rebases the local copy and warm-resets the render.
      await getController()?.reconcile();
      const history = await fetchHistory(docId);
      const done: ChatMessage = {
        role: "agent", text: reply, fromVersion: version, toVersion: getState().version,
      };
      setState({ history, chat: [...getState().chat.slice(0, -1), done] });
    } catch (e) {
      setState({ chat: [...getState().chat.slice(0, -1), { role: "err", text: (e as Error).message }] });
    } finally {
      setState({ chatBusy: false });
    }
  };

  return (
    <section className="col-chat">
      <div className="col-head">
        <strong>Chat</strong>
        <button type="button" className="ops-counter" onClick={() => void openHistory()}>
          {`${sessionOps.length} ops · 本次会话`}
        </button>
        <span className="spacer" />
        <button type="button" className="chip" onClick={() => void newSession()}>新会话</button>
      </div>

      <div className="chat-log">
        {s.chat.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}${m.pending ? " msg-pending" : ""}`}>
            {m.role === "agent" && !m.pending ? (
              <div className="agent-head">
                <span className="agent-mark mono">ir</span>
                <span>Agent</span>
              </div>
            ) : null}
            <div>{m.text}</div>
            {m.fromVersion !== undefined && m.toVersion !== undefined ? (
              <OpsList
                defaultOpen
                entries={s.history.filter((e) => e.version > m.fromVersion! && e.version <= m.toVersion!)}
              />
            ) : null}
          </div>
        ))}
      </div>

      <Composer busy={s.chatBusy} onSend={(t) => void send(t)} />
      {s.historyOpen ? <HistoryDrawer /> : null}
    </section>
  );
}
