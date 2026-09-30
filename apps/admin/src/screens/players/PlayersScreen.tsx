import { PlayerCardView } from "./PlayerCardView";
import { PlayerList } from "./PlayerList";
import { PlayerSearch } from "./PlayerSearch";

/** Раздел «Игроки»: поиск по имени и ID, под ним — список с фильтрами (WP32); выбранный игрок — карточкой. */
export function PlayersScreen({ id }: { id: string | null }) {
  if (id !== null) return <PlayerCardView key={id} accountId={id} />;
  return (
    <div className="flex flex-col gap-4">
      <PlayerSearch />
      <PlayerList />
    </div>
  );
}
