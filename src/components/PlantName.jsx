import { useEffect, useId, useRef, useState } from 'react';

export default function PlantName({ name }) {
  const textRef = useRef(null);
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    setExpanded(false);
    const element = textRef.current;
    const measure = () => {
      // Measure natural text height without the reserved three-line height
      // or space for a toggle that may not be needed.
      const styles = getComputedStyle(element);
      const lineHeight = parseFloat(styles.lineHeight);
      const probe = element.cloneNode(true);
      probe.removeAttribute('id');
      probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, {
        position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
        width: `${element.clientWidth}px`, boxSizing: 'border-box',
        display: 'block', webkitLineClamp: 'unset',
        minHeight: '0', maxHeight: 'none', height: 'auto', padding: '0',
      });
      element.parentElement.appendChild(probe);
      const needsToggle = probe.getBoundingClientRect().height > lineHeight * 3 + 1;
      probe.remove();
      setOverflows(needsToggle);
    };
    measure();
    if (!window.ResizeObserver) {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [name]);

  return (
    <h3 className={`plantName ${overflows ? 'plantName--truncated' : ''} ${expanded ? 'plantName--expanded' : ''}`} title={name}>
      <span className='plantNameText' id={textId} ref={textRef}>{name}</span>
      {overflows && <button
        className='plantNameToggle'
        type='button'
        aria-label={expanded ? 'Свернуть название' : 'Развернуть название'}
        aria-expanded={expanded}
        aria-controls={textId}
        onClick={() => setExpanded((value) => !value)}
      ><svg viewBox='0 0 16 16' width='14' height='14' aria-hidden='true'><path d='m4 6 4 4 4-4' fill='none' stroke='currentColor' strokeWidth='1.5' /></svg></button>}
    </h3>
  );
}
