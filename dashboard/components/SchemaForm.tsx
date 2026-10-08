"use client";

/**
 * A form made from a JSON Schema (Wave 12, C4). The "Try it" box of an action uses it. The schema comes from the manifest of
 * the connector, so the page needs no code for a new connector. The values stay in this component and go out in one call.
 */
import { useId, useMemo, useState } from "react";
import type { JsonSchema } from "@/lib/connectorsApi";
import { buildInput, fieldsFromSchema, type FormField } from "@/lib/connectorsView";

function Control({ id, field, value, onChange, describedBy }: { id: string; field: FormField; value: string; onChange: (v: string) => void; describedBy: string }) {
  const common = { id, "aria-describedby": describedBy, "aria-required": field.required || undefined } as const;
  switch (field.kind) {
    case "select":
      return (
        <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          {field.required ? null : <option value="">(not set)</option>}
          {field.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    case "boolean":
      return (
        <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">(not set)</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case "textarea":
    case "json":
    case "list":
      return <textarea {...common} rows={field.kind === "textarea" ? 4 : 3} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} maxLength={field.maxLength} />;
    case "number":
    case "integer":
      return <input {...common} type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input {...common} type="text" autoComplete="off" spellCheck={false} value={value} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
  }
}

const KIND_HINT: Partial<Record<FormField["kind"], string>> = {
  list: "One value on each line.",
  json: "Write valid JSON.",
  integer: "A whole number.",
  number: "A number.",
};

export default function SchemaForm({
  schema,
  submitLabel,
  busy = false,
  onSubmit,
}: {
  schema: JsonSchema | undefined;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const prefix = useId();
  const fields = useMemo(() => fieldsFromSchema(schema), [schema]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.initial])));
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const built = buildInput(fields, values);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    onSubmit(built.input);
  }

  return (
    <form className="schema-form" noValidate onSubmit={submit}>
      {fields.length === 0 ? <p className="e-dim">This action needs no input.</p> : null}
      {fields.map((f) => {
        const id = `${prefix}-${f.name}`;
        const hintId = `${id}-hint`;
        const hint = [f.help, KIND_HINT[f.kind], f.min !== undefined || f.max !== undefined ? `Range ${f.min ?? "any"} to ${f.max ?? "any"}.` : ""].filter(Boolean).join(" ");
        return (
          <div className="field" key={f.name}>
            <label htmlFor={id}>
              {f.label}
              {f.required ? "" : " (optional)"}
            </label>
            <Control id={id} field={f} value={values[f.name] ?? ""} onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))} describedBy={hintId} />
            <div id={hintId} className="field-hint">{hint}</div>
            {errors[f.name] ? <div className="field-error" role="alert">{errors[f.name]}</div> : null}
          </div>
        );
      })}
      <div className="modal-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Running" : submitLabel}</button>
      </div>
    </form>
  );
}
