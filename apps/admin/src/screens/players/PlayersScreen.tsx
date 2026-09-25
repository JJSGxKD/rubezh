import { PlayerCardView } from "./PlayerCardView";
import { PlayerSearch } from "./PlayerSearch";

export function PlayersScreen({ id }: { id: string | null }) {
  return id === null ? <PlayerSearch /> : <PlayerCardView key={id} accountId={id} />;
}
