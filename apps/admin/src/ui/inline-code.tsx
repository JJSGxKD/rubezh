/**
 * Текст из профиля сети с кодом в обратных кавычках: «`Sonar.show`, событие
 * `onReward`» — вызовы SDK моноширинным, а сами кавычки не видны. Тексты
 * профилей пишет код, а не человек, — разбор на этом и кончается.
 */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="rounded-sm bg-surface-raised px-1 font-mono text-[0.92em]">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
