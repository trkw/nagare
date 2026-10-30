import Anthropic from "@anthropic-ai/sdk";
import { parseHTML } from "linkedom";
import type { Env } from "./env";
import { HttpError } from "./env";

export type Translation = { title: string; content: string; engine: string; cached: boolean };

export type Translator = {
  name: string;
  translate(input: { title: string; html: string; lang: string }): Promise<{ title: string; content: string }>;
};

const LANG_NAMES: Record<string, string> = { ja: "Japanese", en: "English" };
const M2M_NAMES: Record<string, string> = { ja: "japanese", en: "english" };

/** True when most letters are kana or kanji, so a Japanese reader needs no translation. */
export function looksJapanese(text: string): boolean {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters) return false;
  const jp = letters.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu)?.length ?? 0;
  return jp / [...letters].length > 0.3;
}

const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd";

/**
 * Splits HTML into the text of its innermost block elements, so a plain-text model can
 * translate them one by one; `apply` writes the translations back in place.
 */
export function textBlocks(html: string): { texts: string[]; apply: (translated: string[]) => string } {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const blocks = [...document.querySelectorAll(BLOCKS)].filter(
    (el) => !el.querySelector(BLOCKS) && (el.textContent ?? "").trim() !== "",
  );
  if (blocks.length === 0 && (document.body.textContent ?? "").trim() !== "") {
    return {
      texts: [document.body.textContent!.trim()],
      apply: ([t]) => `<p>${escapeHtml(t ?? "")}</p>`,
    };
  }
  return {
    texts: blocks.map((el) => el.textContent!.replace(/\s+/g, " ").trim()),
    apply(translated) {
      blocks.forEach((el, i) => {
        el.textContent = translated[i] ?? el.textContent;
      });
      return document.body.innerHTML;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Workers AI (m2m100): free tier, plain text only, so inline markup inside a block is lost. */
export function workersAiTranslator(ai: Ai): Translator {
  const MAX_BLOCKS = 150;
  return {
    name: "workers-ai/m2m100",
    async translate({ title, html, lang }) {
      const target = M2M_NAMES[lang] ?? lang;
      const run = async (text: string) => {
        if (!text.trim()) return text;
        const out = (await ai.run("@cf/meta/m2m100-1.2b", { text, target_lang: target })) as { translated_text?: string };
        return out.translated_text ?? text;
      };
      const { texts, apply } = textBlocks(html);
      const head = texts.slice(0, MAX_BLOCKS);
      const translated: string[] = [];
      for (let i = 0; i < head.length; i += 6) {
        translated.push(...(await Promise.all(head.slice(i, i + 6).map(run))));
      }
      return { title: await run(title), content: apply([...translated, ...texts.slice(MAX_BLOCKS)]) };
    },
  };
}

/** Claude: keeps the HTML structure and handles any source language. */
export function anthropicTranslator(apiKey: string, model = "claude-opus-5-5"): Translator {
  const client = new Anthropic({ apiKey });
  return {
    name: `anthropic/${model}`,
    async translate({ title, html, lang }) {
      const language = LANG_NAMES[lang] ?? lang;
      const message = await client.beta.messages
        .stream({
          model,
          max_tokens: 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low" },
          system:
            `Translate the article in the user message into natural ${language}. ` +
            "It has a <title> element and an <article> element containing HTML. Keep every tag and attribute " +
            "exactly as given and translate only the human-readable text. Leave code, URLs and proper nouns " +
            "that are usually not translated as they are. Reply with only the translated <title> and <article> elements.",
          messages: [{ role: "user", content: `<title>${escapeHtml(title)}</title>\n<article>${html}</article>` }],
        })
        .finalMessage();
      if (message.stop_reason === "refusal") throw new HttpError(422, "the translation model declined this article");
      if (message.stop_reason === "max_tokens") throw new HttpError(422, "the article is too long to translate in one pass");
      const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const outTitle = text.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
      const outBody = text.match(/<article>([\s\S]*)<\/article>/)?.[1]?.trim();
      if (outBody == null) throw new HttpError(502, "translation came back in an unexpected format");
      return { title: outTitle ?? title, content: outBody };
    },
  };
}

export function defaultTranslator(env: Env): Translator {
  if (env.ANTHROPIC_API_KEY) return anthropicTranslator(env.ANTHROPIC_API_KEY, env.TRANSLATE_MODEL || undefined);
  if (env.AI) return workersAiTranslator(env.AI);
  throw new HttpError(422, "no translation engine is configured");
}

/** Translates an entry (full text when fetched, else the feed content) and caches the result. */
export async function translateEntry(
  env: Env,
  entryId: number,
  lang: string,
  translator: () => Translator = () => defaultTranslator(env),
): Promise<Translation> {
  const cached = await env.DB.prepare("SELECT title, content, engine FROM translations WHERE entry_id = ? AND lang = ?")
    .bind(entryId, lang)
    .first<{ title: string; content: string; engine: string }>();
  if (cached) return { ...cached, cached: true };

  const entry = await env.DB.prepare("SELECT title, COALESCE(full_content, content, '') AS html FROM entries WHERE id = ?")
    .bind(entryId)
    .first<{ title: string; html: string }>();
  if (!entry) throw new HttpError(404, `entry ${entryId} not found`);

  const plain = `${entry.title} ${entry.html.replace(/<[^>]+>/g, " ")}`;
  if (lang === "ja" && looksJapanese(plain)) {
    return { title: entry.title, content: entry.html, engine: "none", cached: false };
  }

  const t = translator();
  const out = await t.translate({ title: entry.title, html: entry.html, lang }).catch((e: Error) => {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `translation failed (${t.name}): ${e.message}`);
  });
  await env.DB.prepare(
    `INSERT INTO translations (entry_id, lang, title, content, engine, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (entry_id, lang) DO UPDATE SET title = excluded.title, content = excluded.content,
       engine = excluded.engine, created_at = excluded.created_at`,
  )
    .bind(entryId, lang, out.title, out.content, t.name, Date.now())
    .run();
  return { ...out, engine: t.name, cached: false };
}
