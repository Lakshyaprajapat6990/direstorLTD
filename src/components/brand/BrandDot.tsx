// The red dot of the DIRECTOR.LTD wordmark: a small flat red circle (no border, gradient or shine) in place of the full stop. Sized
// in em so it scales with the text around it. Screen readers and copy/paste still get the real "." (the visible dot is decorative
// only); the domain, URLs and metadata are untouched. Its look lives in `.brand-dot` in globals.css.
export function BrandDot({ className = "" }: { className?: string }) {
  return (
    <>
      <span className="sr-only">.</span>
      <span aria-hidden="true" className={`brand-dot ${className}`.trim()} />
    </>
  );
}
