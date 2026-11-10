import { LinkButton } from "@/components/ui/Button";
import { ConsentGate } from "@/components/consent/ConsentGate";
import { RichP, RunsP, renderRuns } from "@/components/marketing/RichText";
import { pickBlock } from "@/lib/site-content/rich";
import { E, type Ed } from "@/components/marketing/cms-edit";
import { ctaHref, embedUrl, mediaSrc } from "@/lib/site-content/sections";
import { buttonCss, hasImageDisplay, headingCss, imageCss, sectionCss, stripOverridden, type HeadingStyle, type ImageDisplay } from "@/lib/site-content/styles";
import type { CustomSection } from "@/lib/site-content/defaults";

// The sections an editor can add (see lib/site-content/sections.ts), styled like the built-in ones. Pure rendering of validated
// data: no hooks, no HTML injection, link destinations from a fixed list. `index` is the section's position in the content's
// `custom` list, which is also its editing path (custom.<index>...). `ed` marks elements in the editor's canvas only.

const H2 = "text-4xl font-extrabold tracking-tight text-indigo-900 sm:text-5xl";

function Heading({ value, path, ed, light, look }: { value: string; path: string; ed: Ed; light?: boolean; look?: HeadingStyle }) {
  return (
    <h2 className={`${H2} ${light ? "!text-white" : ""}`} style={headingCss(look)} {...ed(path)}>
      {value}
    </h2>
  );
}

// The display options an image block or image section carries (all optional; none means the original markup).
const display = (s: ImageDisplay): ImageDisplay => ({
  displayWidth: s.displayWidth,
  displayHeight: s.displayHeight,
  fit: s.fit,
  align: s.align,
  radius: s.radius,
  borderWidth: s.borderWidth,
  borderColor: s.borderColor,
  wrap: s.wrap,
});

export function CustomSectionView({ section: s, index, ed, editing }: { section: CustomSection; index: number; ed: Ed; editing: boolean }) {
  const base = `custom.${index}`;
  const wrap = { id: `section-${s.id}`, style: sectionCss(s.style), ...ed(base) };

  if (s.type === "text") {
    return (
      <section {...wrap} className="py-16">
        <div className="mx-auto max-w-3xl px-6">
          {s.title && <Heading value={s.title} path={`${base}.title`} ed={ed} look={s.headingStyle} />}
          <div className={`${s.title ? "mt-6 " : ""}space-y-4${s.blocks.some((b) => b.kind === "image" && (b.wrap === "left" || b.wrap === "right")) ? " flow-root" : ""}`}>
            {s.blocks.map((b, j) => {
              const attrs = ed(`${base}.blocks.${j}`);
              if ("items" in b) {
                const Tag = b.kind === "ol" ? "ol" : "ul";
                return (
                  <Tag key={j} className={`${b.kind === "ol" ? "list-decimal" : "list-disc"} space-y-2 pl-6 text-lg leading-relaxed text-slate-600`} {...attrs}>
                    {b.items.map((runs, k) => (
                      <li key={k}>{renderRuns(runs)}</li>
                    ))}
                  </Tag>
                );
              }
              if (b.kind === "button") {
                const css = buttonCss(b.settings);
                return (
                  <div key={j} className="flex" style={{ justifyContent: b.settings?.align === "right" ? "flex-end" : b.settings?.align === "center" ? "center" : "flex-start" }}>
                    <LinkButton href={b.href} size="lg" className="rounded-md px-8 py-4" style={css} newTab={!!b.settings?.newTab || false} attrs={{ ...(attrs as Record<string, string>) }}>
                      <E ed={ed} path={`${base}.blocks.${j}.label`}>{b.label}</E>
                    </LinkButton>
                  </div>
                );
              }
              if (b.kind === "video") {
                return (
                  <figure key={j} className="relative" {...attrs}>
                    <div className="relative aspect-video overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
                      <ConsentGate provider={b.provider}>
                      <iframe src={embedUrl(b.provider, b.videoId)} title={b.title} loading="lazy" className="absolute inset-0 h-full w-full" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" />
                      </ConsentGate>
                      {editing && <div className="absolute inset-0 z-10" {...attrs} />}
                    </div>
                    {b.caption && <figcaption className="mt-2 text-center text-sm text-slate-500">{b.caption}</figcaption>}
                  </figure>
                );
              }
              if (b.kind === "image") {
                const { wrap: figStyle, img, floatClass } = imageCss(display(b), { width: b.width, height: b.height });
                return (
                  <figure key={j} style={figStyle} className={floatClass || undefined} {...attrs}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- served by our own /media route */}
                    <img src={mediaSrc(b.mediaId)} alt={b.alt} {...(b.width && b.height ? { width: b.width, height: b.height } : {})} loading="lazy" decoding="async" style={img} className="rounded-xl border border-slate-200 bg-slate-50" />
                    {b.caption && <figcaption className="mt-2 text-center text-sm text-slate-500">{b.caption}</figcaption>}
                  </figure>
                );
              }
              const bp = pickBlock(b);
              if (b.kind === "h2") return <RunsP key={j} as="h2" runs={b.runs} align={b.align} block={bp} attrs={attrs} className="pt-2 text-3xl font-bold tracking-tight text-indigo-900" />;
              if (b.kind === "h3") return <RunsP key={j} as="h3" runs={b.runs} align={b.align} block={bp} attrs={attrs} className="pt-1 text-2xl font-semibold text-indigo-900" />;
              return <RunsP key={j} runs={b.runs} align={b.align} block={bp} attrs={attrs} className="text-lg leading-relaxed text-slate-600" />;
            })}
          </div>
        </div>
      </section>
    );
  }

  if (s.type === "image") {
    return (
      <section {...wrap} className="py-12">
        <figure className={`mx-auto px-6 ${s.size === "wide" ? "max-w-6xl" : "max-w-3xl"}`}>
          {hasImageDisplay(display(s)) ? (
            (() => {
              const { wrap: boxStyle, img } = imageCss(display(s), { width: s.width, height: s.height });
              return (
                <div style={boxStyle}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- served by our own /media route */}
                  <img src={mediaSrc(s.mediaId)} alt={s.alt} {...(s.width && s.height ? { width: s.width, height: s.height } : {})} loading="lazy" decoding="async" style={img} className="rounded-2xl border border-slate-200 bg-slate-50" />
                </div>
              );
            })()
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- served by our own /media route, size known from upload
            <img src={mediaSrc(s.mediaId)} alt={s.alt} {...(s.width && s.height ? { width: s.width, height: s.height } : {})} loading="lazy" decoding="async" className="h-auto w-full rounded-2xl border border-slate-200 bg-slate-50" />
          )}
          {s.caption && (
            <figcaption className="mt-3 text-center text-sm text-slate-500" {...ed(`${base}.caption`)}>
              {s.caption}
            </figcaption>
          )}
        </figure>
      </section>
    );
  }

  if (s.type === "video") {
    return (
      <section {...wrap} className="py-12">
        <figure className="mx-auto max-w-4xl px-6">
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
            <ConsentGate provider={s.provider}>
            <iframe
              src={embedUrl(s.provider, s.videoId)}
              title={s.title}
              loading="lazy"
              className="absolute inset-0 h-full w-full"
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            />
            </ConsentGate>
            {editing && <div className="absolute inset-0 z-10" {...ed(base)} />}
          </div>
          {s.caption && (
            <figcaption className="mt-3 text-center text-sm text-slate-500" {...ed(`${base}.caption`)}>
              {s.caption}
            </figcaption>
          )}
        </figure>
      </section>
    );
  }

  if (s.type === "cta") {
    const brand = s.tone === "brand";
    const ctaCss = buttonCss(s.button);
    return (
      <section {...wrap} className={brand ? "bg-gradient-to-br from-indigo-900 to-indigo-950 py-20" : "border-y border-slate-100 bg-slate-50/70 py-20"}>
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className={`text-4xl font-extrabold tracking-tight sm:text-5xl ${brand ? "text-white" : "text-indigo-900"}`} style={headingCss(s.headingStyle)} {...ed(`${base}.heading`)}>
            {s.heading}
          </h2>
          {s.text && <RichP value={s.text} attrs={ed(`${base}.text`)} className={`mx-auto mt-4 max-w-xl text-lg ${brand ? "text-blue-100" : "text-slate-600"}`} />}
          <div className="mt-8 flex justify-center" style={s.button?.align ? { justifyContent: s.button.align === "left" ? "flex-start" : s.button.align === "right" ? "flex-end" : "center" } : undefined}>
            <LinkButton
              href={s.button?.href ?? ctaHref(s.target)}
              size="lg"
              newTab={!!s.button?.newTab}
              style={ctaCss}
              className={brand ? stripOverridden("rounded-md !bg-white px-8 py-4 !text-indigo-900 hover:!bg-blue-50 focus-visible:!outline-white", ctaCss, { bg: ["!bg-white", "hover:!bg-blue-50"], color: ["!text-indigo-900"] }) : "rounded-md px-8 py-4"}
            >
              <E ed={ed} path={`${base}.buttonLabel`}>
                {s.buttonLabel}
              </E>
            </LinkButton>
          </div>
        </div>
      </section>
    );
  }

  if (s.type === "cards") {
    return (
      <section {...wrap} className="py-16">
        <div className="mx-auto max-w-7xl px-6">
          {(s.heading || s.intro) && (
            <div className="mx-auto max-w-3xl text-center">
              {s.heading && <Heading value={s.heading} path={`${base}.heading`} ed={ed} look={s.headingStyle} />}
              {s.intro && <RichP value={s.intro} attrs={ed(`${base}.intro`)} className="mt-4 text-lg text-slate-500" />}
            </div>
          )}
          <div className={`${s.heading || s.intro ? "mt-12 " : ""}grid gap-5 sm:grid-cols-2 lg:grid-cols-3`}>
            {s.cards.map((card, j) => (
              <div key={j} className="rounded-xl border border-slate-200 bg-white p-6">
                <p className="text-xl font-bold text-indigo-900" {...ed(`${base}.cards.${j}.title`)}>
                  {card.title}
                </p>
                <RichP value={card.text} attrs={ed(`${base}.cards.${j}.text`)} className="mt-2 text-[15px] leading-relaxed text-slate-600" />
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  // faq
  return (
    <section {...wrap} className="py-16">
      <div className="mx-auto max-w-3xl px-6">
        <div className="text-center">
          <Heading value={s.heading} path={`${base}.heading`} ed={ed} look={s.headingStyle} />
        </div>
        <div className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
          {s.items.map((item, j) => (
            <details key={j} className="group py-5" open={j === 0}>
              <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 text-left text-lg font-semibold text-indigo-900" {...ed(`${base}.items.${j}.q`)}>
                {item.q}
                <span className="text-2xl font-light text-indigo-600 group-open:hidden">+</span>
                <span className="hidden text-2xl font-light text-indigo-600 group-open:inline">−</span>
              </summary>
              <RichP value={item.a} attrs={ed(`${base}.items.${j}.a`)} className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-600" />
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
