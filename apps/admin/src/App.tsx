import { useEffect } from "react";
import { useSession } from "./state/use-session";
import { Button, Loading, Notice } from "./ui/kit";
import { Login } from "./screens/Login";
import { Shell } from "./screens/Shell";

export function App() {
  const view = useSession((state) => state.view);
  const restore = useSession((state) => state.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  if (view.status === "loading") {
    return (
      <main className="grid min-h-screen place-items-center">
        <Loading />
      </main>
    );
  }
  if (view.status === "anonymous") return <Login />;
  if (view.status === "blocked") {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <div className="flex max-w-md flex-col items-start gap-3">
          <Notice>{view.error.message}</Notice>
          <Button onClick={() => void restore()}>Повторить</Button>
        </div>
      </main>
    );
  }
  return <Shell identity={view.identity} />;
}
