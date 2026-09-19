import type { Task } from "../domain/task";
import { COLUMNS, groupByColumn } from "./columns";

export function Board({
  tasks,
  onSelect,
}: {
  tasks: Task[];
  onSelect: (task: Task) => void;
}) {
  const grouped = groupByColumn(tasks);

  return (
    <div className="board">
      {COLUMNS.map((column) => (
        <section key={column.state} className="column">
          <h2>
            <span className={`tone-dot tone-${column.tone}`} />
            {column.label} <span className="count">{grouped[column.state].length}</span>
          </h2>
          {grouped[column.state].map((task) => (
            <article
              key={task.id}
              className={`card tone-${column.tone}`}
              onClick={() => onSelect(task)}
            >
              <h3>{task.title}</h3>
              <p>{task.body.slice(0, 120)}</p>
              <footer>{task.sourceId}</footer>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
