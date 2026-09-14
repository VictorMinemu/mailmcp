// Landing page motion. Everything here is progressive: without JavaScript the page is
// fully readable, and with reduced motion enabled nothing moves.
const root = document.documentElement;
root.classList.add('js');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const revealed = document.querySelectorAll('[data-reveal]');

if ('IntersectionObserver' in window && !reducedMotion.matches) {
  // Siblings inside a group reveal one after another; CSSOM properties are allowed by the CSP.
  document
    .querySelectorAll('[data-reveal-group]')
    .forEach((group) =>
      [...group.querySelectorAll(':scope > [data-reveal]')].forEach((element, index) =>
        element.style.setProperty('--i', String(index)),
      ),
    );
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  revealed.forEach((element) => observer.observe(element));
} else {
  revealed.forEach((element) => element.classList.add('is-visible'));
}

const masthead = document.querySelector('.masthead');
if (masthead) {
  const onScroll = () => masthead.classList.toggle('is-scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// The marquee loops by translating half its width, so each row needs one exact duplicate.
if (!reducedMotion.matches)
  document.querySelectorAll('.marquee-track').forEach((track) => {
    for (const item of [...track.children]) {
      const copy = item.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      track.append(copy);
    }
  });

// The hero conversation plays once on load and replays while the tab is visible.
const demo = document.querySelector('.demo');
if (demo && !reducedMotion.matches) {
  const replay = () => {
    demo.classList.remove('is-playing');
    void demo.offsetWidth;
    demo.classList.add('is-playing');
  };
  let timer = setInterval(replay, 13_000);
  replay();
  document.addEventListener('visibilitychange', () => {
    clearInterval(timer);
    if (!document.hidden) {
      replay();
      timer = setInterval(replay, 13_000);
    }
  });
}
