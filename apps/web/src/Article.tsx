import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Entry } from "./api";

// Feed HTML is untrusted: sanitize it, and open its links outside the app.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "IMG") node.setAttribute("loading", "lazy");
});

const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

function plainText(html: string): string {
  const doc = new DOMParser().parseFromString(DOMPurify.sanitize(html), "text/html");
  return doc.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export function Article(props: {
  entry: Entry;
  onContent: (content: string) => void;
  onBack: () => void;
  onToggleStar: () => void;
  onToggleRead: () => void;
  onError: (msg: string) => void;
}) {
  const { entry } = props;
  const [speaking, setSpeaking] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [translation, setTranslation] = useState<{ title: string; content: string } | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [busy, setBusy] = useState<"fulltext" | "translate" | null>(null);
  // The entry on screen; responses for an entry the user has left are dropped.
  const currentId = useRef(entry.id);
  currentId.current = entry.id;
  const shown = showTranslation && translation ? translation : { title: entry.title, content: entry.content ?? "" };
  const html = useMemo(() => DOMPurify.sanitize(shown.content), [shown.content]);

  useEffect(() => {
    setHandoffOpen(false);
    setTranslation(null);
    setShowTranslation(false);
    setBusy(null);
    return () => {
      if (canSpeak) speechSynthesis.cancel();
      setSpeaking(false);
    };
  }, [entry.id]);

  function toggleSpeech() {
    if (speaking) {
      speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(`${shown.title}。${plainText(shown.content)}`);
    utterance.lang = "ja-JP";
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ja"));
    if (voice) utterance.voice = voice;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    speechSynthesis.speak(utterance);
    setSpeaking(true);
  }

  async function loadFullText() {
    const id = entry.id;
    setBusy("fulltext");
    try {
      const { content } = await api.fullText(id);
      props.onContent(content);
      if (currentId.current !== id) return;
      setTranslation(null);
      setShowTranslation(false);
    } catch (e) {
      if (currentId.current === id) props.onError((e as Error).message);
    } finally {
      if (currentId.current === id) setBusy(null);
    }
  }

  async function toggleTranslation() {
    if (showTranslation) return setShowTranslation(false);
    if (translation) return setShowTranslation(true);
    const id = entry.id;
    setBusy("translate");
    try {
      const t = await api.translate(id);
      if (currentId.current !== id) return;
      setTranslation(t);
      setShowTranslation(true);
    } catch (e) {
      if (currentId.current === id) props.onError((e as Error).message);
    } finally {
      if (currentId.current === id) setBusy(null);
    }
  }

  return (
    <article className="article">
      <div className="toolbar">
        <button className="back" onClick={props.onBack}>
          ← 一覧
        </button>
        <button onClick={props.onToggleStar} title="あとで読む (s)">
          {entry.starred ? "★ 保存済み" : "☆ あとで読む"}
        </button>
        <button onClick={props.onToggleRead} title="既読/未読 (m)">
          {entry.read ? "未読にする" : "既読にする"}
        </button>
        <button onClick={toggleTranslation} disabled={busy !== null}>
          {busy === "translate" ? "翻訳中…" : showTranslation ? "原文" : "翻訳"}
        </button>
        {entry.url && (
          <button onClick={loadFullText} disabled={busy !== null} title="元のページから本文を取得">
            {busy === "fulltext" ? "取得中…" : "全文"}
          </button>
        )}
        {canSpeak && <button onClick={toggleSpeech}>{speaking ? "■ 停止" : "▶ 読み上げ"}</button>}
        <button onClick={() => setHandoffOpen((v) => !v)}>エージェントに送る</button>
        {entry.url && (
          <a className="button" href={entry.url} target="_blank" rel="noopener noreferrer" title="元の記事 (v)">
            元の記事 ↗
          </a>
        )}
      </div>

      {handoffOpen && (
        <HandoffForm
          entryId={entry.id}
          onDone={() => setHandoffOpen(false)}
          onError={props.onError}
        />
      )}

      <header>
        <div className="meta">
          {entry.feed_title}
          {entry.author ? ` · ${entry.author}` : ""} · {new Date(entry.published_at).toLocaleString("ja-JP")}
        </div>
        <h1>{shown.title || "（タイトルなし）"}</h1>
      </header>
      {entry.content === undefined ? (
        <p className="muted">読み込み中…</p>
      ) : (
        <div className="content" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </article>
  );
}

function HandoffForm({ entryId, onDone, onError }: { entryId: number; onDone: () => void; onError: (msg: string) => void }) {
  const [note, setNote] = useState("");
  const [agent, setAgent] = useState("");
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.handoff([entryId], note.trim(), agent.trim());
      setSent(true);
      setTimeout(onDone, 1200);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  if (sent) return <div className="handoff sent">送りました。エージェントが次に確認したときに受け取ります。</div>;
  return (
    <form className="handoff" onSubmit={submit}>
      <textarea
        placeholder="気づいたこと、調べてほしいことなど"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        autoFocus
      />
      <div className="row">
        <input placeholder="送り先（空ならどのエージェントでも）" value={agent} onChange={(e) => setAgent(e.target.value)} />
        <button type="submit">送る</button>
      </div>
    </form>
  );
}
