import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, getToken, setToken, type Entry, type Feed, type Me } from "./api";
import { Article } from "./Article";

type View = { kind: "all" } | { kind: "starred" } | { kind: "folder"; name: string } | { kind: "feed"; id: number };

const PAGE = 50;

function sameView(a: View, b: View): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then(setMe)
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="center muted">読み込み中…</div>;
  if (!me) return <Login onLogin={setMe} />;
  return (
    <Reader
      me={me}
      onLogout={() => {
        setToken(null);
        setMe(null);
      }}
    />
  );
}

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const me = await api.me(token.trim());
      if (me.kind !== "app") throw new Error("アプリ用のトークンを使ってください");
      setToken(token.trim());
      onLogin(me);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "トークンが正しくありません" : (err as Error).message);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Nagare</h1>
      <p className="muted">
        アプリ用のトークンを入力してください（<code>bun run token:create --kind app</code> で発行）。
      </p>
      <input
        type="password"
        placeholder="ngr_..."
        value={token}
        onChange={(e) => setTokenInput(e.target.value)}
        autoFocus
      />
      <button type="submit" disabled={!token.trim()}>
        はじめる
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Reader({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [view, setView] = useState<View>({ kind: "all" });
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Bumped per list request; a response whose number is stale belongs to an old query.
  const requestSeq = useRef(0);

  const refreshFeeds = useCallback(() => api.feeds().then(setFeeds).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    refreshFeeds();
  }, [refreshFeeds]);

  const query = useMemo(() => {
    const unread = view.kind !== "starred" && unreadOnly;
    if (view.kind === "starred") return { starred: true };
    if (view.kind === "folder") return { folder: view.name, unread };
    if (view.kind === "feed") return { feed: view.id, unread };
    return { unread };
  }, [view, unreadOnly]);

  const load = useCallback(
    async (more: boolean) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const last = more ? entries.at(-1) : undefined;
        const page = await api.entries({ ...query, limit: PAGE, before: last?.published_at, before_id: last?.id });
        if (seq !== requestSeq.current) return;
        setEntries((prev) => (more ? [...prev, ...page] : page));
        setHasMore(page.length === PAGE);
      } catch (e) {
        if (seq === requestSeq.current) setError((e as Error).message);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [entries, query],
  );

  useEffect(() => {
    setSelected(null);
    load(false);
    // Reload only when the query changes, not when the list grows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const patchEntry = useCallback((id: number, patch: Partial<Entry>) => {
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
    setSelected((s) => (s && s.id === id ? { ...s, ...patch } : s));
  }, []);

  const setRead = useCallback(
    (entry: Entry, read: boolean) => {
      if (!!entry.read === read) return;
      patchEntry(entry.id, { read: read ? 1 : 0 });
      setFeeds((fs) => fs.map((f) => (f.id === entry.feed_id ? { ...f, unread: f.unread + (read ? -1 : 1) } : f)));
      api.setState([entry.id], { read }).catch((e: Error) => setError(e.message));
    },
    [patchEntry],
  );

  const toggleStar = useCallback(
    (entry: Entry) => {
      const starred = !entry.starred;
      patchEntry(entry.id, { starred: starred ? 1 : 0 });
      api.setState([entry.id], { starred }).catch((e: Error) => setError(e.message));
    },
    [patchEntry],
  );

  const open = useCallback(
    async (entry: Entry) => {
      setSelected(entry);
      setRead(entry, true);
      try {
        const full = await api.entry(entry.id);
        setSelected((s) => (s?.id === entry.id ? { ...full, read: 1 } : s));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [setRead],
  );

  const move = useCallback(
    (delta: number) => {
      const i = selected ? entries.findIndex((e) => e.id === selected.id) : -1;
      const next = entries[Math.min(Math.max(i + delta, 0), entries.length - 1)];
      if (next && next.id !== selected?.id) {
        open(next);
        listRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
      }
    },
    [entries, selected, open],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "j") move(1);
      else if (e.key === "k") move(-1);
      else if (e.key === "s" && selected) toggleStar(selected);
      else if (e.key === "m" && selected) setRead(selected, !selected.read);
      else if (e.key === "v" && selected?.url) window.open(selected.url, "_blank", "noopener");
      else if (e.key === "r") refreshFeeds().then(() => load(false));
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, selected, toggleStar, setRead, refreshFeeds, load]);

  const folders = useMemo(() => {
    const map = new Map<string, Feed[]>();
    for (const f of feeds) {
      const key = f.folder ?? "";
      map.set(key, [...(map.get(key) ?? []), f]);
    }
    return [...map].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ja")));
  }, [feeds]);

  const totalUnread = feeds.reduce((n, f) => n + f.unread, 0);
  const currentFeed = view.kind === "feed" ? feeds.find((f) => f.id === view.id) : undefined;
  const title =
    view.kind === "all"
      ? "すべて"
      : view.kind === "starred"
        ? "あとで読む"
        : view.kind === "folder"
          ? view.name
          : (currentFeed?.title ?? "");

  return (
    <div className={`reader${selected ? " has-selection" : ""}`}>
      <nav className="sidebar">
        <div className="brand">
          <span>Nagare</span>
          <button className="link" onClick={onLogout} title={`${me.name} でログイン中`}>
            ログアウト
          </button>
        </div>
        <ul>
          <NavItem label="すべて" count={totalUnread} active={sameView(view, { kind: "all" })} onClick={() => setView({ kind: "all" })} />
          <NavItem label="あとで読む" active={sameView(view, { kind: "starred" })} onClick={() => setView({ kind: "starred" })} />
        </ul>
        {folders.map(([folder, list]) => (
          <section key={folder}>
            {folder ? (
              <button
                className={`folder${sameView(view, { kind: "folder", name: folder }) ? " active" : ""}`}
                onClick={() => setView({ kind: "folder", name: folder })}
              >
                {folder}
              </button>
            ) : (
              <div className="folder muted">フォルダなし</div>
            )}
            <ul>
              {list.map((f) => (
                <NavItem
                  key={f.id}
                  label={f.title || f.url}
                  count={f.unread}
                  badge={f.added_by && f.added_by !== me.name ? f.added_by : undefined}
                  hint={f.last_error ? `取得エラー: ${f.last_error}` : (f.reason ?? undefined)}
                  warn={!!f.last_error}
                  active={sameView(view, { kind: "feed", id: f.id })}
                  onClick={() => setView({ kind: "feed", id: f.id })}
                />
              ))}
            </ul>
          </section>
        ))}
        <SubscribeForm
          onDone={(feed) => {
            refreshFeeds();
            setView({ kind: "feed", id: feed.id });
          }}
          onError={setError}
        />
      </nav>

      <section className="list">
        <header>
          <h2>{title}</h2>
          {view.kind !== "starred" && (
            <label className="toggle">
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              未読のみ
            </label>
          )}
        </header>
        {currentFeed && (currentFeed.reason || currentFeed.added_by !== me.name) && (
          <div className="feed-note">
            {currentFeed.added_by && currentFeed.added_by !== me.name && <strong>{currentFeed.added_by} が追加</strong>}
            {currentFeed.reason && <span>{currentFeed.reason}</span>}
            <button
              className="link danger"
              onClick={async () => {
                if (!confirm(`「${currentFeed.title}」の購読をやめますか？`)) return;
                await api.unsubscribe(currentFeed.id).catch((e: Error) => setError(e.message));
                setView({ kind: "all" });
                refreshFeeds();
              }}
            >
              購読をやめる
            </button>
          </div>
        )}
        <ul ref={listRef}>
          {entries.map((e) => (
            <li
              key={e.id}
              data-id={e.id}
              className={`entry${e.read ? " read" : ""}${selected?.id === e.id ? " active" : ""}`}
              onClick={() => open(e)}
            >
              <div className="meta">
                <span>{e.feed_title}</span>
                <time>{relativeTime(e.published_at)}</time>
              </div>
              <div className="title">
                {e.starred ? <span className="star">★</span> : null}
                {e.title || "（タイトルなし）"}
              </div>
            </li>
          ))}
        </ul>
        {!loading && entries.length === 0 && <p className="empty muted">記事はありません</p>}
        {hasMore && (
          <button className="more" disabled={loading} onClick={() => load(true)}>
            さらに読み込む
          </button>
        )}
      </section>

      <main className="article-pane">
        {selected ? (
          <Article
            entry={selected}
            onContent={(content) => patchEntry(selected.id, { content })}
            onBack={() => setSelected(null)}
            onToggleStar={() => toggleStar(selected)}
            onToggleRead={() => setRead(selected, !selected.read)}
            onError={setError}
          />
        ) : (
          <div className="center muted">記事を選んでください（j / k で移動）</div>
        )}
      </main>

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
}

function NavItem(props: {
  label: string;
  count?: number;
  badge?: string;
  hint?: string;
  warn?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button className={`nav-item${props.active ? " active" : ""}`} onClick={props.onClick} title={props.hint}>
        <span className={`label${props.warn ? " warn" : ""}`}>{props.label}</span>
        {props.badge && <span className="badge">{props.badge}</span>}
        {!!props.count && <span className="count">{props.count}</span>}
      </button>
    </li>
  );
}

function SubscribeForm({ onDone, onError }: { onDone: (feed: Feed) => void; onError: (msg: string) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { feed } = await api.subscribe(url.trim());
      setUrl("");
      onDone(feed);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="subscribe" onSubmit={submit}>
      <input placeholder="サイトかフィードのURL" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button type="submit" disabled={busy || !url.trim()}>
        {busy ? "探しています…" : "購読"}
      </button>
    </form>
  );
}

const rtf = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

function relativeTime(ms: number): string {
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "たった今";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(ms).toLocaleDateString("ja-JP");
}
