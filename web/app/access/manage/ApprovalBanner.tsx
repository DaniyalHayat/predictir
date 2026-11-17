'use client';

import {Check, ChevronDown, ChevronUp, CircleAlert, LoaderCircle, ShieldAlert, X} from 'lucide-react';
import {useCallback, useEffect, useId, useRef, useState} from 'react';
import type {MouseEvent, TouchEvent} from 'react';
import styles from './approval-banner.module.css';

type Decision = 'approved' | 'declined';
type Outcome = Decision | 'expired';

type ApprovalBannerProps = {
  request: {id: string; name: string; email: string; createdAt: string};
  autoOpen?: boolean;
  onDismiss: () => void;
  onDecision: (id: string, decision: Decision) => Promise<Outcome>;
};

const requestTime = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
const outcomeCopy = {
  approved: {title: 'Request approved', detail: 'The requester can now open Predictir.', Icon: Check},
  declined: {title: 'Request rejected', detail: 'The access request was rejected.', Icon: X},
  expired: {title: 'Request expired', detail: 'This access request is no longer pending.', Icon: CircleAlert},
};

export default function ApprovalBanner({request, autoOpen = false, onDismiss, onDecision}: ApprovalBannerProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const compact = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const swipe = useRef<{x: number; y: number} | null>(null);
  const submitting = useRef(false);
  const dismissed = useRef(false);
  const [expanded, setExpanded] = useState(autoOpen);
  const [pending, setPending] = useState<Decision | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState('');

  const dismiss = useCallback(() => {
    if (submitting.current || dismissed.current) return;
    dismissed.current = true;
    const modal = dialog.current;
    const wasExpanded = Boolean(modal?.open);
    const banner = wasExpanded ? modal : compact.current;
    function finish() {
      if (banner && !banner.isConnected) return;
      modal?.close();
      onDismiss();
      if (wasExpanded && previousFocus.current?.isConnected) previousFocus.current.focus({preventScroll: true});
    }
    if (!banner || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    banner.dataset.dismissing = '';
    const start = getComputedStyle(banner);
    void banner.animate([
      {transform: start.transform, opacity: start.opacity},
      {transform: 'translateY(calc(-100% - env(safe-area-inset-top, 0px) - 12px))', opacity: 0},
    ], {duration: 200, easing: 'cubic-bezier(.45, 0, .64, 1)', fill: 'forwards'}).finished.then(finish, finish);
  }, [onDismiss]);

  useEffect(() => {
    if (autoOpen) setExpanded(true);
  }, [autoOpen]);

  useEffect(() => {
    const modal = dialog.current;
    if (expanded && modal && !modal.open && !dismissed.current) modal.showModal();
  }, [expanded]);

  useEffect(() => {
    if (expanded) return;
    function clickOutside(event: globalThis.MouseEvent) {
      if (compact.current && !event.composedPath().includes(compact.current)) dismiss();
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) dismiss();
    }
    document.addEventListener('click', clickOutside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('click', clickOutside);
      document.removeEventListener('keydown', escape);
    };
  }, [dismiss, expanded]);

  useEffect(() => {
    if (outcome) done.current?.focus();
  }, [outcome]);

  function rememberFocus(target: EventTarget | null) {
    if (target instanceof HTMLElement && target !== document.body && target !== compact.current) previousFocus.current = target;
  }

  function expand() {
    if (dismissed.current) return;
    rememberFocus(document.activeElement);
    setExpanded(true);
  }

  function startSwipe(event: TouchEvent<HTMLElement>) {
    const point = event.touches.length === 1 ? event.touches[0] : null;
    swipe.current = point ? {x: point.clientX, y: point.clientY} : null;
  }

  function endSwipe(event: TouchEvent<HTMLElement>) {
    const start = swipe.current;
    swipe.current = null;
    const point = event.changedTouches[0];
    if (!start || !point || event.touches.length) return;
    const distance = start.y - point.clientY;
    if (distance >= 48 && Math.abs(start.x - point.clientX) < distance * .75) dismiss();
  }

  function clickBackdrop(event: MouseEvent<HTMLDialogElement>) {
    const modal = event.currentTarget;
    if ('closedBy' in modal || event.target !== modal) return;
    const {top, right, bottom, left} = modal.getBoundingClientRect();
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dismiss();
  }

  async function decide(decision: Decision) {
    if (submitting.current || dismissed.current || outcome) return;
    submitting.current = true;
    setPending(decision);
    setError('');
    try {
      setOutcome(await onDecision(request.id, decision));
    } catch {
      setError('Couldn’t save the decision. Try again.');
    } finally {
      submitting.current = false;
      setPending(null);
    }
  }

  const swipeHandlers = {onTouchStart: startSwipe, onTouchEnd: endSwipe, onTouchCancel: () => {swipe.current = null;}};
  const result = outcome ? outcomeCopy[outcome] : null;
  const date = new Date(request.createdAt);

  return <>
    {!expanded && <button type="button" ref={compact} className={`${styles.surface} ${styles.compact} ${styles.summary}`}
      aria-haspopup="dialog" aria-controls={id} onClick={expand} onFocus={event => rememberFocus(event.relatedTarget)} {...swipeHandlers}>
      <span className={styles.appIcon}><ShieldAlert size={22} aria-hidden="true"/></span>
      <span className={styles.summaryCopy}>
        <strong>Approval required</strong>
        <span>Someone requested access to Predictir.</span>
      </span>
      <ChevronDown size={20} aria-hidden="true"/>
    </button>}

    <dialog ref={dialog} id={id} className={`${styles.surface} ${styles.modal}`} closedby={pending ? 'none' : 'any'}
      aria-labelledby={`${id}-title`} onClose={dismiss} onClick={clickBackdrop}
      onCancel={event => {event.preventDefault(); dismiss();}}>
      {expanded && <>
        <button type="button" className={styles.summary} onClick={dismiss} aria-label="Dismiss approval banner"
          aria-disabled={Boolean(pending)} {...swipeHandlers}>
          <span className={styles.appIcon}><ShieldAlert size={22} aria-hidden="true"/></span>
          <span className={styles.summaryCopy}>
            <strong id={`${id}-title`}>{result?.title ?? 'Approval required'}</strong>
            <span>Predictir access request</span>
          </span>
          <ChevronUp size={20} aria-hidden="true"/>
        </button>

        <div className={styles.expansion}>
          <div className={styles.clip}>
            <div className={styles.details}>
              {result ? <span className={styles.resultIcon} data-outcome={outcome} aria-hidden="true">
                <result.Icon size={27} strokeWidth={2.5}/>
              </span> : <dl className={styles.fields}>
                <dt>Name</dt><dd>{request.name}</dd>
                <dt>Email</dt><dd>{request.email}</dd>
                <dt>Requested</dt><dd>{Number.isFinite(+date) ? <time dateTime={request.createdAt}>{requestTime.format(date)}</time> : 'Unavailable'}</dd>
                <dt>Action</dt><dd>Access to Predictir</dd>
              </dl>}

              <p className={styles.feedback} role="status" aria-atomic="true" data-error={error ? true : undefined}>
                {result?.detail ?? (pending ? 'Saving decision…' : error)}
              </p>

              {result ? <button type="button" ref={done} className={styles.done} onClick={dismiss}>Done</button> :
                <div className={styles.actions} aria-busy={Boolean(pending)}>
                  <button type="button" className={styles.approve} aria-disabled={Boolean(pending)}
                    aria-label={`Approve access for ${request.name}`} onClick={() => void decide('approved')}>
                    {pending === 'approved' ? <LoaderCircle className={styles.spinner} size={22} aria-hidden="true"/> :
                      <Check size={22} strokeWidth={2.5} aria-hidden="true"/>} Approve
                  </button>
                  <button type="button" className={styles.reject} aria-disabled={Boolean(pending)}
                    aria-label={`Reject access for ${request.name}`} onClick={() => void decide('declined')}>
                    {pending === 'declined' ? <LoaderCircle className={styles.spinner} size={22} aria-hidden="true"/> :
                      <X size={22} strokeWidth={2.5} aria-hidden="true"/>} Reject
                  </button>
                </div>}
            </div>
          </div>
        </div>
      </>}
    </dialog>
  </>;
}
