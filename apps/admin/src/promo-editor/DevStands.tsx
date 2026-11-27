import { Notice } from "../ui/kit";
import { PromoEditorDemo } from "./PromoEditorDemo";

/**
 * Витрины компонентов панели — только в сборке разработки: раздел `dev` есть
 * в меню и в `SECTION_SCREENS` лишь при `import.meta.env.DEV`
 * (`routes.ts`, `screens/sections.tsx`). Новая витрина — строка здесь.
 */
const STANDS = [{ id: "promo-editor", title: "Редактор промо" }] as const;

export default function DevStands({ id }: { id: string | null }) {
  if (id === "promo-editor") return <PromoEditorDemo />;
  return (
    <div className="flex flex-col gap-3">
      {id === null ? null : <Notice tone="warning">Такой витрины нет.</Notice>}
      <ul className="list-disc pl-5 text-sm">
        {STANDS.map((stand) => (
          <li key={stand.id}>
            <a className="text-accent underline" href={`#/dev/${stand.id}`}>
              {stand.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
