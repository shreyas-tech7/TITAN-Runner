"use client";

/** The table of providers on the Keys page. On a narrow screen each row becomes a card, so the page never scrolls sideways. */
import { Badge } from "@/components/kit";
import type { KeyRow } from "@/lib/keysApi";
import { STATE_META, describeCheck, describeProof, keyColumn, modelsColumn, savedColumn } from "@/lib/keyState";

export default function KeysTable({
  rows,
  onAdd,
  onTest,
  onRemove,
}: {
  rows: KeyRow[];
  onAdd: (providerId: string) => void;
  onTest: (row: KeyRow) => void;
  onRemove: (row: KeyRow) => void;
}) {
  return (
    <table className="keys-table">
      <caption className="sr-only">Provider keys and their state</caption>
      <thead>
        <tr>
          <th scope="col">Provider</th>
          <th scope="col">State</th>
          <th scope="col">Key</th>
          <th scope="col">Saved</th>
          <th scope="col">Provider check</th>
          <th scope="col">Runner proof</th>
          <th scope="col">Models</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const meta = STATE_META[row.state];
          return (
            <tr key={row.id} data-provider={row.id} data-state={row.state}>
              <td data-label="Provider">
                <strong>{row.label}</strong>
                <div className="e-dim e-num">{row.id}</div>
              </td>
              <td data-label="State">
                <Badge tone={meta.tone} title={row.stateReason}>{meta.label}</Badge>
                <div className="e-dim">{row.stateReason}</div>
              </td>
              <td data-label="Key" className="e-num">{keyColumn(row)}</td>
              <td data-label="Saved">{savedColumn(row) || <span className="e-dim">not saved</span>}</td>
              <td data-label="Provider check">{row.secretPresent ? describeCheck(row.providerCheck) : <span className="e-dim">no key</span>}</td>
              <td data-label="Runner proof">{row.secretPresent ? describeProof(row.runnerProof) : <span className="e-dim">no key</span>}</td>
              <td data-label="Models">{modelsColumn(row) || <span className="e-dim">none found</span>}</td>
              <td data-label="Actions" className="keys-actions">
                <button className="btn btn-quiet" onClick={() => onAdd(row.id)}>{row.secretPresent ? "Replace" : "Add"}</button>
                {row.secretPresent ? <button className="btn btn-quiet" onClick={() => onTest(row)}>Test now</button> : null}
                {row.secretPresent ? <button className="btn btn-quiet" onClick={() => onRemove(row)}>Remove</button> : null}
                {row.getKeyUrl ? (
                  <a className="btn btn-quiet" href={row.getKeyUrl} target="_blank" rel="noopener noreferrer">Get a free key</a>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
