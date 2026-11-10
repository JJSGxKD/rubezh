import type { ReactNode } from "react";
import { Dialog } from "../../ui/dialog";
import { InlineCode } from "../../ui/inline-code";
import { Button } from "../../ui/kit";
import { useNarrow } from "../../ui/use-media";
import { LINKS_GUIDE, type GuideBlock, type GuideListItem, type GuideSection } from "./links-guide";

/**
 * Окно «Как устроены ссылки»: оглавление сверху, разделы ниже. Весь текст — в `links-guide.ts`,
 * здесь только вёрстка. Оглавление — кнопки, а не якоря `#…`: панель живёт на хэш-маршрутах
 * (`#/links/<код>`), и ссылка-якорь увела бы с экрана. Окно монтируется только открытым, поэтому
 * после закрытия оно открывается с начала.
 */

const ANCHOR_PREFIX = "links-guide-";

const anchorOf = (section: GuideSection): string => `${ANCHOR_PREFIX}${section.id}`;

function scrollTo(id: string): void {
  const target = document.getElementById(id);
  if (target === null) return;
  // Прокрутка внутри окна: `scrollIntoView` двигает ближайший прокручиваемый предок, то есть тело окна.
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
}

export function LinksGuide({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Как устроены ссылки"
      description="Какую ссылку брать, что происходит от клика до игрока, что значат поля и счётчики и что проверить, если ссылка не работает"
    >
      {/* Рвать можно только код: адреса и ключи длинные и раздвинули бы окно, а обычные слова остаются целыми. */}
      <div className="flex flex-col gap-6 [overflow-wrap:break-word] [&_code]:[overflow-wrap:anywhere]">
        <nav id={`${ANCHOR_PREFIX}contents`} aria-label="Оглавление справки">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm marker:text-text-muted sm:columns-2">
            {LINKS_GUIDE.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className="min-h-8 text-left text-accent hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent max-md:min-h-10"
                  onClick={() => scrollTo(anchorOf(section))}
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {LINKS_GUIDE.map((section) => (
          <Section key={section.id} section={section} />
        ))}
      </div>
    </Dialog>
  );
}

function Section({ section }: { section: GuideSection }) {
  const anchor = anchorOf(section);
  return (
    <section id={anchor} aria-labelledby={`${anchor}-title`} className="flex flex-col gap-3">
      <h3 id={`${anchor}-title`} className="border-b border-border pb-1 text-base font-semibold">
        {section.title}
      </h3>
      {section.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
      <div>
        <Button className="text-xs" onClick={() => scrollTo(`${ANCHOR_PREFIX}contents`)}>
          К оглавлению
        </Button>
      </div>
    </section>
  );
}

function Block({ block }: { block: GuideBlock }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="text-sm leading-relaxed whitespace-pre-line">
          <InlineCode text={block.text} />
        </p>
      );
    case "list":
      return <GuideList items={block.items} ordered={block.ordered === true} {...(block.title === undefined ? {} : { title: block.title })} />;
    case "table":
      return <GuideTable head={block.head} rows={block.rows} />;
  }
}

function GuideList({ items, ordered, title }: { items: readonly GuideListItem[]; ordered: boolean; title?: string }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <div className="flex flex-col gap-1.5">
      {title === undefined ? null : <h4 className="text-sm font-semibold">{title}</h4>}
      <Tag className={`${ordered ? "list-decimal" : "list-disc"} flex flex-col gap-1.5 pl-5 text-sm leading-relaxed marker:text-text-muted`}>
        {items.map((item, index) => (
          <li key={index} className="whitespace-pre-line">
            {typeof item === "string" ? <InlineCode text={item} /> : <ExternalLink href={item.href} text={item.text} />}
          </li>
        ))}
      </Tag>
    </div>
  );
}

function ExternalLink({ href, text }: { href: string; text: string }): ReactNode {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
      <InlineCode text={text} />
    </a>
  );
}

/** Код не длиннее этого в ячейке не рвётся: ключ настроек или короткое значение читается только целиком. */
const SHORT_CODE = 28;

/** Ячейка, где весь код короткий, держит его целым; адреса-образцы длиннее и переносятся. */
function cellClass(text: string): string {
  const spans = text.split("`").filter((_, index) => index % 2 === 1);
  return spans.length > 0 && spans.every((span) => span.length <= SHORT_CODE) ? "[&_code]:whitespace-nowrap" : "";
}

/**
 * Таблица справки. На ПК — обычная таблица; на телефоне каждая строка — карточка: первая ячейка
 * заголовком, остальные подписаны названиями столбцов. Боковая прокрутка пальцем неудобна и прячет
 * столбцы, поэтому её нет.
 */
function GuideTable({ head, rows }: { head: readonly string[]; rows: readonly (readonly string[])[] }) {
  const narrow = useNarrow();
  if (narrow) {
    return (
      <ul className="flex flex-col gap-2">
        {rows.map((row, rowIndex) => (
          <li key={rowIndex} className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
            <div className={`text-sm font-semibold ${cellClass(row[0] ?? "")}`}>
              <InlineCode text={row[0] ?? ""} />
            </div>
            <dl className="flex flex-col gap-1.5">
              {row.slice(1).map((cell, cellIndex) => (
                <div key={cellIndex} className="flex flex-col gap-0.5">
                  <dt className="text-xs text-text-muted">{head[cellIndex + 1]}</dt>
                  <dd className={`text-sm leading-relaxed ${cellClass(cell)}`}>
                    <InlineCode text={cell} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <table className="w-full border-collapse text-left text-xs leading-relaxed">
      <thead>
        <tr className="border-b border-border text-text-muted">
          {head.map((title) => (
            <th key={title} scope="col" className="px-2 py-1.5 font-medium">
              {title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="border-b border-border/60 align-top">
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} className={`px-2 py-2 ${cellIndex === 0 ? "font-semibold" : ""} ${cellClass(cell)}`}>
                <InlineCode text={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
