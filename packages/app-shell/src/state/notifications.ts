import { create } from "zustand";

/**
 * Непрочитанные уведомления — только число для колокольчика в шапке
 * (docs/35-stage4-plan.md Р51, §3.17). Лента и запросы — в
 * `notifications-api.ts`, отдельным чанком: первой загрузке нужно только
 * число, и то после входа.
 */
export const useNotifications = create<{ unread: number }>()(() => ({ unread: 0 }));
