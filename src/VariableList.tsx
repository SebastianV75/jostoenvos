import { projectEnvDocument } from './env-document.js';

export function VariableList({ draft, revealed }: { draft: string; revealed: boolean }) {
  const projection = projectEnvDocument(draft);
  return <>
    {projection.incompleteFromLine !== null && <p className="warning" role="status">
      Incomplete variable display. Projection stopped at line {projection.incompleteFromLine}. Use Raw to inspect the remaining text. The original document is unchanged.
    </p>}
    {projection.assignments.length ? <dl className="variable-list" aria-label="Environment variables">
      {projection.assignments.map(row => <div className="variable-row" key={row.line}>
        <dt>{row.name}</dt>
        <dd>{revealed ? row.value === '' ? <span className="technical">Empty value</span> : row.value
          : <span className="technical">Value hidden</span>}</dd>
      </div>)}
    </dl> : <p>No supported assignments to display. Use Raw to inspect or edit the document.</p>}
    <p className="technical">Read-only projection of the current draft. Values use literal raw spelling, not runtime dotenv evaluation. Edit in Raw.</p>
  </>;
}
