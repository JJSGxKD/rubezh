/** Отдать браузеру файл, собранный на странице: архив выгрузки, отчёт в JSON. */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // Ссылка нужна браузеру только на время клика.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
