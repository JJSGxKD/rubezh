import { BOARD_TITLES, DIFFICULTIES, type RatingBoard, type RatingDifficulty } from "../../api/rating";
import { difficultyTitle } from "../../api/review";
import { hrefOf } from "../../routes";
import { HELP } from "../../ui/help";
import { Help, Select } from "../../ui/kit";

/** Переключатель сложности: подписи — как в игре. */
export function DifficultySelect({ value, onChange }: { value: RatingDifficulty; onChange: (value: RatingDifficulty) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      Сложность
      <Select value={value} onChange={(event) => onChange(DIFFICULTIES.find((id) => id === event.target.value) ?? value)}>
        {DIFFICULTIES.map((id) => (
          <option key={id} value={id}>
            {capitalize(difficultyTitle(id))}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** Общая или полная доска; рисуется только при праве `players.board.restrict` — без права его нет вовсе. */
export function BoardSelect({ value, onChange }: { value: RatingBoard; onChange: (value: RatingBoard) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      Доска
      <Help text={HELP.rating.board} />
      <Select value={value} onChange={(event) => onChange(event.target.value === "full" ? "full" : "common")}>
        {(Object.keys(BOARD_TITLES) as RatingBoard[]).map((id) => (
          <option key={id} value={id}>
            {BOARD_TITLES[id]}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** Имя игрока — ссылка в его карточку, на вкладку «Забеги», где лежат места по неделям. */
export function PlayerLink({ accountId, name }: { accountId: string; name: string }) {
  return (
    <a className="text-accent hover:underline" href={hrefOf({ section: "players", id: accountId, tab: "runs" })} onClick={(event) => event.stopPropagation()}>
      {name}
    </a>
  );
}

export const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
