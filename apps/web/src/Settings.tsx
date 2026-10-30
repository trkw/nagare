import { useEffect, useState } from "react";
import { api, type Credential, type CredentialInput, type Feed } from "./api";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          <button className="link" onClick={onClose}>
            閉じる
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<Credential["kind"], string> = { basic: "ID・パスワード", header: "ヘッダー", cookie: "Cookie" };

/** Saved logins for protected feeds. Secrets are write-only: the server never sends them back. */
export function CredentialsPanel(props: { credentials: Credential[]; onChange: () => void; onClose: () => void; onError: (m: string) => void }) {
  const [kind, setKind] = useState<Credential["kind"]>("basic");
  const [form, setForm] = useState({ name: "", host: "", username: "", password: "", header_name: "", header_value: "", cookie: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const base = { name: form.name.trim(), host: form.host.trim() };
    const input: CredentialInput =
      kind === "basic"
        ? { ...base, kind, username: form.username, password: form.password }
        : kind === "header"
          ? { ...base, kind, header_name: form.header_name.trim(), header_value: form.header_value }
          : { ...base, kind, cookie: form.cookie };
    try {
      await api.addCredential(input);
      setForm({ name: "", host: "", username: "", password: "", header_name: "", header_value: "", cookie: "" });
      props.onChange();
    } catch (err) {
      props.onError((err as Error).message);
    }
  }

  async function remove(c: Credential) {
    if (!confirm(`「${c.name}」を削除しますか？これを使っているフィードは取得できなくなります。`)) return;
    await api.deleteCredential(c.id).catch((e: Error) => props.onError(e.message));
    props.onChange();
  }

  return (
    <Modal title="ログイン情報" onClose={props.onClose}>
      <p className="muted small">
        パスワード付きのフィードや会員ページ用です。暗号化して保存し、登録したホストにだけ送ります。エージェントは名前で指定できますが、中身は見られません。
      </p>
      {props.credentials.length > 0 && (
        <ul className="cred-list">
          {props.credentials.map((c) => (
            <li key={c.id}>
              <span>
                <strong>{c.name}</strong> <span className="muted">{c.host} · {KIND_LABEL[c.kind]}</span>
              </span>
              <button className="link danger" onClick={() => remove(c)}>
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="stack" onSubmit={add}>
        <div className="row">
          <input placeholder="名前（例: note会員）" value={form.name} onChange={set("name")} />
          <input placeholder="ホスト（例: example.com）" value={form.host} onChange={set("host")} />
        </div>
        <div className="segmented">
          {(Object.keys(KIND_LABEL) as Credential["kind"][]).map((k) => (
            <button type="button" key={k} className={k === kind ? "active" : ""} onClick={() => setKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {kind === "basic" && (
          <div className="row">
            <input placeholder="ID" autoComplete="off" value={form.username} onChange={set("username")} />
            <input placeholder="パスワード" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} />
          </div>
        )}
        {kind === "header" && (
          <div className="row">
            <input placeholder="ヘッダー名（例: X-Api-Key）" value={form.header_name} onChange={set("header_name")} />
            <input placeholder="値" type="password" autoComplete="off" value={form.header_value} onChange={set("header_value")} />
          </div>
        )}
        {kind === "cookie" && (
          <input placeholder="Cookie（例: session=...）" type="password" autoComplete="off" value={form.cookie} onChange={set("cookie")} />
        )}
        <button type="submit" disabled={!form.name.trim() || !form.host.trim()}>
          追加
        </button>
      </form>
    </Modal>
  );
}

export function FeedSettings(props: {
  feed: Feed;
  credentials: Credential[];
  onSaved: () => void;
  onClose: () => void;
  onError: (m: string) => void;
}) {
  const { feed } = props;
  const [title, setTitle] = useState(feed.title);
  const [folder, setFolder] = useState(feed.folder ?? "");
  const [selector, setSelector] = useState(feed.selector ?? "");
  const [credential, setCredential] = useState(feed.credential ?? "");
  const [notify, setNotify] = useState(!!feed.notify);
  const [preview, setPreview] = useState<{ title: string; items: { url: string | null; title: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const host = new URL(feed.url).hostname;
  const usable = props.credentials.filter((c) => c.host === host);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateFeed(feed.id, {
        title: title.trim() || undefined,
        folder: folder.trim() || null,
        notify,
        ...(feed.kind === "web" && selector !== (feed.selector ?? "") ? { selector: selector.trim() || null } : {}),
        ...(feed.kind !== "agent" && credential !== (feed.credential ?? "") ? { credential: credential || null } : {}),
      });
      if (feed.kind !== "agent") await api.refreshFeed(feed.id).catch(() => undefined);
      props.onSaved();
      props.onClose();
    } catch (err) {
      props.onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function tryPreview() {
    try {
      setPreview(await api.previewPage(feed.url, { selector: selector.trim() || undefined, credential: credential || undefined }));
    } catch (err) {
      props.onError((err as Error).message);
    }
  }

  return (
    <Modal title="フィードの設定" onClose={props.onClose}>
      <form className="stack" onSubmit={save}>
        <p className="muted small url">{feed.url}</p>
        {feed.last_error && <p className="error small">取得エラー: {feed.last_error}</p>}
        <label>
          名前
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          フォルダ
          <input placeholder="なし" value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>
        {feed.kind === "web" && (
          <label>
            記事にする部分（CSSセレクタ）
            <div className="row">
              <input placeholder="空なら自動で見つけます" value={selector} onChange={(e) => setSelector(e.target.value)} />
              <button type="button" onClick={tryPreview}>
                試す
              </button>
            </div>
          </label>
        )}
        {preview && (
          <ul className="preview small">
            {preview.items.length === 0 && <li className="muted">何も見つかりません</li>}
            {preview.items.slice(0, 8).map((it, i) => (
              <li key={i}>{it.title}</li>
            ))}
          </ul>
        )}
        {feed.kind !== "agent" && (
          <label>
            ログイン
            <select value={credential} onChange={(e) => setCredential(e.target.value)}>
              <option value="">使わない</option>
              {usable.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="toggle">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          新しい記事を通知する
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </button>
      </form>
    </Modal>
  );
}
