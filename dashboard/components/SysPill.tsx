"use client";

/**
 * A system alert as a small pill. The pill says what is wrong in a few words. A click opens a window with the
 * detail and the action. This replaces the wide red banner that took the top of the page.
 */
import { useState, type ReactNode } from "react";
import { useModal } from "@/components/useModal";

export type PillTone = "ok" | "info" | "warn" | "danger";

export function SysPill({
  tone,
  code,
  text,
  title,
  children,
  role,
}: {
  tone: PillTone;
  /** The machine label, such as SYS_WARNING. */
  code: string;
  text: string;
  /** The title of the detail window. */
  title: string;
  /** The detail window body. */
  children: ReactNode;
  role?: "alert" | "status";
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sys-pill-wrap" role={role}>
      <button type="button" className={`sys-pill sys-pill-${tone}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="sys-pill-dot" aria-hidden="true" />
        <span className="sys-pill-code">{code}</span>
        <span className="sys-pill-text">{text}</span>
      </button>
      {open ? (
        <SysDialog title={title} onClose={() => setOpen(false)}>
          {children}
        </SysDialog>
      ) : null}
    </div>
  );
}

function SysDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useModal(onClose);
  return (
    <div className="overlay-scrim" onClick={onClose}>
      <div className="modal hud-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="sys-dialog-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-head">
            <h2 className="modal-title" id="sys-dialog-title">
              {title}
            </h2>
            <button className="btn btn-quiet" onClick={onClose} aria-label="Close this window">
              Close
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
