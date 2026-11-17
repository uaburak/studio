// Assistant Markdown, Claude Code style: bold run-in headings, #/## headings, bullet lists
// (filled dot, nested hollow circle), numbered lists, inline code pills, code blocks with a
// copy button, tables with a hairline grid, quotes and links. Tokens from `marked`'s lexer are
// rendered as React elements (no HTML injection), so partial (streaming) text is safe.
import { type ConversationAlias, resolveAliasMentions } from "@studio/contract";
import { Lexer, type Token, type Tokens } from "marked";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { bridge } from "../../lib/bridge.ts";
import { cn } from "../ui/controls.tsx";
import { IconCheck, IconCopy } from "../ui/icons.tsx";

export interface MarkdownEnv {
  aliases: ConversationAlias[];
  onMention?(aliasId: string): void;
}

const EnvContext = createContext<MarkdownEnv>({ aliases: [] });

export function parseMarkdown(source: string): Token[] {
  return Lexer.lex(source, { gfm: true, breaks: false });
}

export function Markdown({ source, env }: { source: string; env?: MarkdownEnv }) {
  const tokens = useMemo(() => parseMarkdown(source), [source]);
  return (
    <EnvContext.Provider value={env ?? { aliases: [] }}>
      <div className="markdown selectable text-prose text-fg">{renderBlocks(tokens, 0)}</div>
    </EnvContext.Provider>
  );
}

function renderBlocks(tokens: Token[], depth: number): ReactNode[] {
  return tokens.map((token, index) => (
    <Block key={index} token={token} depth={depth} first={index === 0} />
  ));
}

/** A paragraph that is only bold text acts as a section heading (Claude's run-in headings). */
export function isRunInHeading(token: Token): boolean {
  if (token.type !== "paragraph") return false;
  const inline = (token as Tokens.Paragraph).tokens ?? [];
  const meaningful = inline.filter((t) => !(t.type === "text" && !t.raw.trim()));
  return meaningful.length === 1 && meaningful[0]?.type === "strong";
}

function Block({ token, depth, first }: { token: Token; depth: number; first: boolean }) {
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const t = token as Tokens.Heading;
      const size = t.depth === 1 ? "text-[17px] leading-6" : "text-prose";
      return (
        <h3 className={cn("font-semibold text-fg", size, first ? "mt-0" : "mt-5", "mb-2")}>
          <Inline tokens={t.tokens} />
        </h3>
      );
    }
    case "paragraph": {
      const t = token as Tokens.Paragraph;
      const heading = isRunInHeading(token);
      return (
        <p
          className={cn(first ? "mt-0" : heading ? "mt-[18px]" : "mt-3.5", heading && "mb-[-4px]")}
        >
          <Inline tokens={t.tokens} />
        </p>
      );
    }
    case "text": {
      const t = token as Tokens.Text;
      return <span>{t.tokens ? <Inline tokens={t.tokens} /> : t.text}</span>;
    }
    case "list":
      return <List token={token as Tokens.List} depth={depth} first={first} />;
    case "code":
      return (
        <CodeBlock
          code={(token as Tokens.Code).text}
          lang={(token as Tokens.Code).lang}
          first={first}
        />
      );
    case "table":
      return <Table token={token as Tokens.Table} first={first} />;
    case "blockquote":
      return (
        <blockquote
          className={cn(
            "border-l-[3px] border-fg-3/60 pl-3.5 text-fg-2",
            first ? "mt-0" : "mt-3.5",
          )}
        >
          {renderBlocks((token as Tokens.Blockquote).tokens, depth)}
        </blockquote>
      );
    case "hr":
      return <hr className="my-5 border-0 border-t border-hairline" />;
    case "html":
      return <p className={first ? "" : "mt-3.5"}>{(token as Tokens.HTML).text}</p>;
    default:
      return null;
  }
}

function List({ token, depth, first }: { token: Tokens.List; depth: number; first: boolean }) {
  const Tag = token.ordered ? "ol" : "ul";
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Tag className={cn("flex flex-col gap-2", first ? "mt-0" : depth > 0 ? "mt-2" : "mt-3.5")}>
      {token.items.map((item, index) => (
        <li key={index} className="relative pl-[23px]">
          <span
            aria-hidden="true"
            className="absolute top-0 left-0 flex h-[22px] w-[18px] items-center justify-center text-fg"
          >
            {token.ordered ? (
              <span className="w-full text-right tabular-nums">{start + index}.</span>
            ) : depth === 0 ? (
              <span className="size-[5px] rounded-full bg-current" />
            ) : (
              <span className="size-[6px] rounded-full border border-current" />
            )}
          </span>
          <ListItemBody item={item} depth={depth} />
        </li>
      ))}
    </Tag>
  );
}

function ListItemBody({ item, depth }: { item: Tokens.ListItem; depth: number }) {
  return (
    <>
      {item.tokens.map((token, index) => {
        if (token.type === "list")
          return <List key={index} token={token as Tokens.List} depth={depth + 1} first={false} />;
        if (token.type === "text") {
          const t = token as Tokens.Text;
          return <span key={index}>{t.tokens ? <Inline tokens={t.tokens} /> : t.text}</span>;
        }
        return <Block key={index} token={token} depth={depth + 1} first={index === 0} />;
      })}
    </>
  );
}

export function CodeBlock({
  code,
  lang,
  first = false,
}: {
  code: string;
  lang?: string | undefined;
  first?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] bg-field shadow-[inset_0_0_0_1px_var(--border-hairline)]",
        first ? "mt-0" : "mt-3.5",
      )}
    >
      <div className="flex h-8 items-center justify-between pr-1.5 pl-3 text-footnote text-fg-2">
        <span>{lang || "kod"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          }}
          className="flex h-6 items-center gap-1 rounded-full px-2 hover:bg-control hover:text-fg"
        >
          {copied ? (
            <IconCheck size={12} strokeWidth={2} />
          ) : (
            <IconCopy size={12} strokeWidth={1.75} />
          )}
          {copied ? "Kopyalandı" : "Kopyala"}
        </button>
      </div>
      <pre className="selectable overflow-x-auto px-3 pt-1 pb-3 font-mono text-mono text-fg">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Table({ token, first }: { token: Tokens.Table; first: boolean }) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-[10px] border border-border",
        first ? "mt-0" : "mt-3.5",
      )}
    >
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="bg-field">
            {token.header.map((cell, index) => (
              <th
                key={index}
                className="h-[34px] px-3 text-left font-semibold whitespace-nowrap text-fg"
                style={{ textAlign: (token.align[index] ?? "left") as "left" }}
              >
                <Inline tokens={cell.tokens} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, r) => (
            <tr key={r} className="border-t border-hairline">
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="h-[34px] px-3 align-middle text-fg"
                  style={{ textAlign: (token.align[c] ?? "left") as "left" }}
                >
                  <Inline tokens={cell.tokens} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Inline({ tokens }: { tokens: Token[] | undefined }) {
  if (!tokens) return null;
  return (
    <>
      {tokens.map((token, index) => (
        <InlineToken key={index} token={token} />
      ))}
    </>
  );
}

function InlineToken({ token }: { token: Token }) {
  switch (token.type) {
    case "strong":
      return (
        <strong className="font-semibold">
          <Inline tokens={(token as Tokens.Strong).tokens} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inline tokens={(token as Tokens.Em).tokens} />
        </em>
      );
    case "del":
      return (
        <del className="text-fg-2">
          <Inline tokens={(token as Tokens.Del).tokens} />
        </del>
      );
    case "codespan":
      return (
        <code className="rounded-[5px] bg-control px-[5px] py-px font-mono text-[0.86em]">
          {decodeEntities((token as Tokens.Codespan).text)}
        </code>
      );
    case "br":
      return <br />;
    case "link": {
      const t = token as Tokens.Link;
      return (
        <a
          href={t.href}
          onClick={(event) => {
            event.preventDefault();
            if (/^https?:/i.test(t.href)) void bridge().openExternal(t.href);
          }}
          className="cursor-pointer text-accent-text underline-offset-2 hover:underline"
          title={t.href}
        >
          <Inline tokens={t.tokens} />
        </a>
      );
    }
    case "image":
      return <span className="text-fg-2">[{(token as Tokens.Image).text || "görsel"}]</span>;
    case "escape":
      return <>{(token as Tokens.Escape).text}</>;
    case "text": {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) return <Inline tokens={t.tokens} />;
      return <MentionText text={decodeEntities(t.text)} />;
    }
    case "html":
      return <>{(token as Tokens.HTML).text}</>;
    default:
      return <>{"raw" in token ? (token as { raw: string }).raw : null}</>;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Plain text with `@alias` mentions as pills (only names the conversation knows). */
export function MentionText({
  text,
  aliases,
  onMention,
}: {
  text: string;
  aliases?: ConversationAlias[];
  onMention?: (aliasId: string) => void;
}) {
  const env = useContext(EnvContext);
  const list = aliases ?? env.aliases;
  const open = onMention ?? env.onMention;
  if (list.length === 0 || !text.includes("@")) return <>{text}</>;
  const mentions = resolveAliasMentions(text, list);
  if (mentions.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const m of mentions) {
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    const current = list.find((a) => a.id === m.aliasId)?.alias ?? m.alias;
    parts.push(
      <MentionPill
        key={`${m.start}-${m.aliasId}`}
        alias={current}
        onClick={open ? () => open(m.aliasId) : undefined}
      />,
    );
    cursor = m.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function MentionPill({
  alias,
  onClick,
}: {
  alias: string;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-px inline-flex h-[20px] translate-y-[-1px] items-center rounded-full bg-accent-subtle px-1.5 align-middle text-[0.9em] text-accent-text hover:bg-accent-subtle/80"
    >
      @{alias}
    </button>
  );
}
