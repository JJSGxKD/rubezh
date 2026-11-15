// Конвейер тимлида (T-0477, Р224). Запуск: Workflow({ name: 'pipeline', args: { lanes: 6 } }).
// Аргументы (все необязательные):
//   lanes     — число линий (по умолчанию 6): каждая берёт провал поезда, потом PR на ревью
//               по старшинству, потом новую задачу;
//   maxTasks  — сколько новых задач сценарий берёт всего (по умолчанию 0: только ревью и провалы);
//   priority  — номера задач, которые брать первыми, например ['T-0477'];
//   exclude   — задачи, которые не брать (чужие потоки, ждущие владельца);
//   skipPrs   — номера PR, которые не ревьюить;
//   seeds     — продолжение остановленного: { kind: 'fix', pr, branch, task, effort, worktree, issues }
//               или { kind: 'task', task, executor, effort, worktree };
//   adopt     — потоки, чьи PR доводим сами (подпись «Поток: <имя>» в описании), кроме claude-lead-1;
//   adoptPrs  — номера PR из веток queue/* и backup/*, которые всё же берём;
//   root      — абсолютный путь основного клона тимлида: нужен, если у агентов другая рабочая
//               папка; без него команды идут от корня репозитория, где запущен сценарий.
// Состояние поезда — .lead/ основного клона (scripts/lead/paths.sh); постановка в
// очередь — scripts/lead/enqueue.sh.
export const meta = {
  name: 'pipeline',
  description: 'Конвейер тимлида на N линий: провалы поезда → ревью PR по старшинству → новая задача; одобренное уходит в поезд мерджей, деньги и миграции (effort extra) проверяют два ревьюера',
  phases: [{ title: 'Ревью' }, { title: 'Задачи' }],
}

const A = { lanes: 6, maxTasks: 0, priority: [], exclude: [], skipPrs: [], seeds: [], adopt: [], adoptPrs: [], ...(args ?? {}) }
const ROOT = A.root ? String(A.root).replace(/[\\/]+$/, '') : ''
const LEAD = ROOT ? `${ROOT}/scripts/lead` : 'scripts/lead'
const HOME = ROOT ? `cd ${ROOT}` : 'из корня репозитория, где запущен сценарий'
const EFFORT = { low: 'low', medium: 'medium', high: 'high', extra: 'xhigh' }
const MODEL = (executor) => (String(executor || '').startsWith('haiku') ? 'haiku' : 'sonnet')
const REVIEW_MODEL = (effort) => (effort === 'extra' ? 'opus' : 'sonnet')
const REVIEW_EFFORT = (effort) => (effort === 'low' || effort === 'medium' ? 'medium' : 'high')
const EXCLUDE = A.exclude
const taken = new Set()
const seen = new Set(A.skipPrs)
const handledFails = new Set()
const fixingPrs = new Set()
const results = []
let picked = 0

const RULES = (t) => `
Общие правила (репозиторий «Рубеж», Windows, Git Bash; комментарии, коммиты и PR — на русском, по CLAUDE.md):
- Работай только в своей рабочей копии. Основной клон${ROOT ? ` (${ROOT})` : ''} не переключай и не правь.
- pnpm install --frozen-lockfile после смены ветки или влития dev (EPERM/UNKNOWN на Windows — повтори).
- Решения сам — по tasks/README.md «Что исполнитель решает сам» (Р176), с записью в «Отступления» PR. Чего Р176 не покрывает — самый осторожный вариант и пункт в «Вопросы».
- Интеграционные тесты: source ${LEAD}/test-env.sh t${String(t.task).slice(2, 6)} (база rubezh_test со схемой t${String(t.task).slice(2, 6)}, Redis 13). Dev-базу bullet_heaven и Redis 14 не трогать. Классификатор отклонил запуск — не обходить, интеграцию прогонит CI. Миграцию без базы — по Р177.
- Гейт локально: pnpm typecheck из корня, pnpm lint, тесты затронутых пакетов, для оболочки — pnpm build и pnpm budget, pnpm docs:check. Машина общая: параллельно работают ещё 5 агентов — весь pnpm test только при широких правках.
- Снимки экранов — pnpm screens (scripts/screens), ширины из спецификации.
- Нельзя: .env, main, настройки репозитория, прод, адрес сервера и юзернеймы; Remove-Item -Recurse; git push --force; чужие PR; задачи и ветки, исключённые тимлидом (${EXCLUDE.join(', ') || 'нет'}); вливать PR самому (вливает только поезд мерджей тимлида).
- Коммиты дробные, type(scope): Текст на русском.
- В описании PR перед подписью агента: «Поток: claude-lead-1 / ${t.executor || 'sonnet-5.5'} / ${t.effort || 'high'}» и «Запустил: владелец». «Для игроков» без строк — одно слово «нет». Метка статуса — ровно одна, метка релиза — из раздела «PR» спецификации.`

// Постановка в поезд — скриптом: он сам находит .lead/ основного клона, откуда бы ни был запущен.
const ENQUEUE = (pr) => `bash ${LEAD}/enqueue.sh ${pr}`

const SCOUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['trainfix', 'review', 'task', 'none'] },
    pr: { type: 'number' }, branch: { type: 'string' }, task: { type: 'string' }, effort: { type: 'string' }, executor: { type: 'string' },
    lead: { type: 'boolean', description: 'в описании PR есть «Поток: claude-lead-1»' },
    failLine: { type: 'number', description: 'номер строки train-failed.txt для trainfix' }, reason: { type: 'string' },
  },
  required: ['kind', 'pr', 'branch', 'task', 'effort', 'executor', 'lead', 'failLine', 'reason'],
}
const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pr', 'skipped', 'failed'] },
    pr: { type: 'number' }, branch: { type: 'string' }, worktree: { type: 'string' },
    summary: { type: 'string' }, deviations: { type: 'array', items: { type: 'string' } }, questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'pr', 'branch', 'worktree', 'summary', 'deviations', 'questions'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    difficulty: { type: 'boolean' }, enqueued: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } }, required: ['file', 'problem', 'fix'] } },
    nits: { type: 'array', items: { type: 'string' } }, questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'difficulty', 'enqueued', 'issues', 'nits', 'questions'],
}
const FIX_SCHEMA = { type: 'object', properties: { fixed: { type: 'array', items: { type: 'string' } }, notFixed: { type: 'array', items: { type: 'string' } }, blocking: { type: 'boolean', description: 'true — осталось что-то, без чего PR вливать нельзя; справочные заметки (местные сбои Windows, имя ветки, вопросы владельцу) — false' }, worktree: { type: 'string' }, enqueued: { type: 'boolean' } }, required: ['fixed', 'notFixed', 'blocking', 'worktree', 'enqueued'] }
const CHECK_SCHEMA = { type: 'object', properties: { closed: { type: 'boolean' }, open: { type: 'array', items: { type: 'string' } }, enqueued: { type: 'boolean' } }, required: ['closed', 'open', 'enqueued'] }

function issuesText(issues) { return issues.map((i, k) => `${k + 1}. ${i.file}: ${i.problem} → ${i.fix}`).join('\n') }

// ---------- ревью ----------
async function reviewLens(item, lens) {
  const { pr, branch, t } = item
  return agent(`Ты — ревьюер тимлида claude-lead-1. Прими PR #${pr} (ветка ${branch}) по задаче ${t.task}. Загрузи скилл review-pr (Skill tool) и пройди чек-лист приёмки. Метки не меняй, не мерджи, в PR ничего не пиши — верни вердикт.
Читай без переключения веток (${HOME}): git fetch origin; gh pr diff ${pr} целиком; git show origin/${branch}:<путь>; спецификация — git show origin/${branch}:tasks/<файл ${t.task}> (или tasks/archive/); зоны — GITHUB_HEAD_REF=${branch} node scripts/tasks/task.mjs diff-check --base origin/dev; CI — gh pr checks ${pr} (по каждой проверке смотри последний прогон; board не важен); прошлые замечания — gh pr view ${pr} --comments.
Сверь шаги спецификации, «Чего не трогаем», критерии ([x] — правда выполнены), тесты проверяют заявленное (а не подогнаны), границы слоёв, детерминизм, Zod на границах, безопасность и нагрузку, миграции expand-only, события из словаря, документы и гайдбук, i18n (ключи есть, падежи и множественное число верны), селекторы Zustand без новых объектов. Снимки, которых требует спецификация, но их нет, — блокирующее (исправление: снять pnpm screens и приложить). difficulty=true, если PR усложняет игру.
Блокирующие — только реальные дефекты, расхождения со спецификацией, красный последний прогон gate или check; вкусовщина — в nits. gate ещё идёт — не повод для changes.
${lens ? lens.focus + ' В поезд НЕ ставь, enqueued=false: решение примет тимлид по двум ревью.' : 'Если вердикт approve — ПОСЛЕДНИМ шагом поставь PR в поезд мерджей: ' + ENQUEUE(pr) + ' и верни enqueued=true. При changes в очередь не ставь.'}`,
    { label: `ревью #${pr} ${t.task}${lens ? ' · ' + lens.name : ''}`, phase: 'Ревью', model: REVIEW_MODEL(t.effort), effort: REVIEW_EFFORT(t.effort), schema: REVIEW_SCHEMA })
}


// Р224, G: деньги, миграции и конкурентность (effort extra) — два независимых
// ревьюера с разными линзами; блокирует любой.
const LENSES = [
  { name: 'корректность', focus: 'Твоя линза — КОРРЕКТНОСТЬ: шаги спецификации, краевые случаи, тесты проверяют заявленное, миграции, идемпотентность, гонки. Безопасность смотрит второй ревьюер.' },
  { name: 'безопасность', focus: 'Твоя линза — БЕЗОПАСНОСТЬ и ДЕНЬГИ: права и гварды маршрутов, доступ к чужим данным, Zod на границах, секреты и логи, Decimal/bigint у денег, повтор запроса не задваивает начисление, аудит денежных действий, docs/15 §7 построчно. Корректность смотрит второй ревьюер.' },
]
async function review(item) {
  if (item.t.effort !== 'extra') return reviewLens(item, null)
  // По очереди, а не вместе: одна линия конвейера — один агент (лимит владельца — 6 агентов).
  const got = []
  for (const lens of LENSES) {
    const r = await reviewLens(item, lens)
    if (r) got.push(r)
  }
  if (got.length === 0) return null
  const issues = got.flatMap((r) => r.issues)
  const verdict = got.some((r) => r.verdict === 'changes' && r.issues.length > 0) ? 'changes' : 'approve'
  return { verdict, difficulty: got.some((r) => r.difficulty), enqueued: false, issues, nits: got.flatMap((r) => r.nits), questions: got.flatMap((r) => r.questions) }
}

async function fixPr(item, issues, why) {
  const { t, pr, branch } = item
  return agent(`Ты — исполнитель claude-lead-1. Доработай PR #${pr} (ветка ${branch}, задача ${t.task}): ${why}. ${item.worktree ? `Рабочая копия — ${item.worktree} (cd туда; git status — там может быть начатая прошлым агентом правка, продолжи её; git fetch origin; ветка для push — ${branch}: git push origin HEAD:${branch}).` : `Ты в отдельной рабочей копии: git fetch origin; git checkout -B ${branch} origin/${branch}; pnpm install --frozen-lockfile.`} Влей origin/dev (merge, без rebase; конфликты чужих tasks/*.md и tasks/epics.md — версия dev и node scripts/tasks/task.mjs fix).
${issuesText(issues)}
Требование спецификации выполняй, а не описывай как невыполненное. Несогласен — не правь, объясни в notFixed. Тесты на исправления, гейт, коммиты, push без --force. Затем bash ${LEAD}/wait-checks.sh ${pr} (повторяй до green/red, не дольше 40 минут; red — причина gh run view <id> --log-failed, исправь, до 3 кругов). Метки не меняй. Комментарий в PR, подписанный **claude-lead-1:**, что исправлено. Верни путь рабочей копии (pwd -W). enqueued=false (в поезд ставит перепроверка).
${RULES(t)}`,
    { label: `доработка #${pr}`, phase: 'Ревью', model: 'sonnet', effort: EFFORT[t.effort] ?? 'high', ...(item.worktree ? {} : { isolation: 'worktree' }), schema: FIX_SCHEMA })
}

async function recheck(item, issues) {
  const { t, pr, branch } = item
  return agent(`Ты — ревьюер тимлида claude-lead-1. Проверь, что доработка PR #${pr} (ветка ${branch}, задача ${t.task}) закрыла замечания и ничего не сломала рядом. Только чтение (кроме постановки в очередь), в PR не пиши, метки не меняй.
git fetch origin; gh pr diff ${pr}; gh pr view ${pr} --comments; git show origin/${branch}:<путь>; gh pr checks ${pr} (последний прогон каждой проверки).
Замечания:
${issuesText(issues)}
closed=true — все закрыты по существу и последние прогоны gate и check не красные. Тогда ПОСЛЕДНИМ шагом: ${ENQUEUE(pr)}, enqueued=true. Иначе open — что осталось, конкретно, enqueued=false.`, { label: `перепроверка #${pr}`, phase: 'Ревью', model: 'sonnet', effort: 'medium', schema: CHECK_SCHEMA })
}

async function returnPr(pr, issues) {
  return agent(`Оформи возврат PR #${pr} на доработку по скиллу review-pr (Skill tool): комментарий в PR, подписанный **claude-lead-1:**, с пунктами ниже; метка «доработка» вместо «на ревью» (ровно одна метка статуса). Код не правь, не мерджи.
${issuesText(issues)}`, { label: `возврат #${pr}`, phase: 'Ревью', model: 'haiku', effort: 'low' })
}

// ревью → доработка и перепроверка (до двух кругов) → поезд
async function reviewFlow(item) {
  const rec = { pr: item.pr, task: item.t.task, kind: 'review' }
  results.push(rec)
  const rv = await review(item)
  rec.review = rv
  if (!rv) return rec
  if (rv.verdict === 'approve' || rv.issues.length === 0) {
    if (!rv.enqueued) await agent(`Выполни одну команду и больше ничего: ${ENQUEUE(item.pr)}`, { label: `в поезд #${item.pr}`, phase: 'Ревью', model: 'haiku', effort: 'low' })
    log(`#${item.pr} ${item.t.task}: одобрен — в поезд`)
    return rec
  }
  if (!item.lead && !rv.difficulty) { await returnPr(item.pr, rv.issues); rec.returned = true; log(`#${item.pr}: возвращён на доработку`); return rec }
  return fixLoop(item, rv.issues, 'замечания ревью тимлида', rec)
}

async function fixLoop(item, firstIssues, why, rec) {
  let issues = firstIssues
  for (let round = 1; round <= 2; round++) {
    const fix = await fixPr(item, issues, why)
    rec.fix = fix
    if (!fix) { log(`#${item.pr}: доработка не ответила — оставляю тимлиду`); return rec }
    if (fix.worktree) item.worktree = fix.worktree
    if (fix.blocking) { rec.left = fix.notFixed; log(`#${item.pr}: доработка не закрыла всё — оставляю тимлиду`); return rec }
    const chk = await recheck(item, issues)
    rec.recheck = chk
    if (chk && chk.closed) {
      if (!chk.enqueued) await agent(`Выполни одну команду и больше ничего: ${ENQUEUE(item.pr)}`, { label: `в поезд #${item.pr}`, phase: 'Ревью', model: 'haiku', effort: 'low' })
      log(`#${item.pr}: доработан — в поезд`)
      return rec
    }
    if (round === 2 || !chk) { rec.left = chk ? chk.open : ['перепроверка не ответила']; log(`#${item.pr}: замечания остались после двух кругов — оставляю тимлиду`); return rec }
    issues = chk.open.map((o) => ({ file: 'по перепроверке', problem: o, fix: 'закрыть по существу' }))
  }
  return rec
}

// ---------- задача ----------
async function pickTask() {
  const r = await agent(`Выбери ОДНУ следующую свободную задачу реестра (${HOME}, только чтение, ветки не переключай).
git fetch -q origin; затем pnpm -s task streams и pnpm -s task next для --executor sonnet-5.5 --effort low|medium|high|extra и --executor haiku-5.5 --effort low|medium.
Только СВОБОДНЫЕ (раздел «Свободные задачи», включая «брошенный захват»), не «на доработке», не «заделом», без незакрытых зависимостей, не runner human. Не бери: [${EXCLUDE.concat([...taken]).join(', ')}].
Приоритет: 1) первая свободная по порядку [${A.priority.join(', ')}]; 2) наименьший номер пачки (п.N), при равенстве — то, что усложняет игру или чинит деньги.
Верни kind "task", task, executor и effort из строки задачи, остальные поля пустые/0/false. Нечего брать — kind "none".`,
    { label: 'выбор задачи', phase: 'Задачи', model: 'haiku', effort: 'low', schema: SCOUT_SCHEMA })
  return r && r.kind === 'task' && r.task ? r : null
}

async function implement(t, cont) {
  return agent(`Ты — исполнитель claude-lead-1. Задача ${t.task}: спецификация tasks/${t.task}-*.md.
${cont ? `Продолжи начатое: рабочая копия ${cont} (cd туда), ветка task/${t.task} уже захвачена, прошлый агент остановлен посреди работы. git status, git log origin/dev..HEAD, git log origin/task/${t.task}..HEAD — посмотри, что сделано и что запушено, и доведи задачу.` : `Захвати задачу: pnpm task claim ${t.task} --owner "claude-lead-1 / ${t.executor} / ${t.effort}". Отказ (уже взяли, зоны заняты, зависимости) — ничего не делай, верни status "skipped" с причиной.`}
Загрузи скилл take-task (Skill tool) и иди по нему${cont ? '' : ' с шага «тесты до кода»'}: тесты первым коммитом, изменения только в зонах задачи (и по Р176), документы, гейт, затем скилл pre-pr и PR в dev с меткой статуса «на ревью» (не черновик). В описании — «Отступления», «Вопросы» (если есть), чек-листы, ## Для игроков, ## Сводка для команды (без ограждения \`\`\`, номер PR вписан после создания), в конце 🤖 Generated with [Claude Code](https://claude.com/claude-code). Для экранов — снимки pnpm screens на ширинах из спецификации. Файл задачи: status: done по tasks/README.md. Следующую задачу не бери, своё PR не ревьюй и не вливай — его возьмёт другая линия.
${RULES(t)}
Верни status, номер PR, ветку, абсолютный путь рабочей копии, итог, отступления, вопросы.`,
    { label: `код ${t.task}`, phase: 'Задачи', model: MODEL(t.executor), effort: EFFORT[t.effort] ?? 'high', ...(cont ? {} : { isolation: 'worktree' }), schema: IMPL_SCHEMA })
}

// ---------- выбор работы линии ----------
async function scoutWork() {
  return agent(`Найди ОДНУ работу для линии конвейера тимлида (${HOME}, только чтение). Порядок важен:
Сначала: node ${LEAD}/train-status.mjs — JSON {queued, approved, failed}; считать строки самому не нужно.
A) Провалы поезда: первый элемент failed, у которого line не из [${[...handledFails].join(', ')}], pr не из [${[...fixingPrs].join(', ')}] и PR ещё открыт (gh pr view <n> --json state) — kind "trainfix", pr, failLine = line, reason.
B) Иначе — PR на ревью: gh pr list --base dev --state open --limit 80 --json number,headRefName,isDraft,labels,body. Подходит: не черновик; метка «на ревью»; нет меток «задел», «ждёт владельца», «доработка»; ветка не queue/* и не backup/* (кроме PR из [${A.adoptPrs.join(', ')}] — их берём); номер не из [${[...seen].join(', ')}] и не из approved. Возьми PR с НАИМЕНЬШИМ номером — kind "review".
Для A и B: task — из ветки task/T-NNNN[-N] или строки «Задача: tasks/T-NNNN…»; effort — git fetch -q origin; git show origin/<ветка>:tasks/<файл задачи> (или tasks/archive/) | grep '^effort:' (нет — "high"); executor — так же из '^executor:' (нет — sonnet-5.5); lead=true, если в описании есть «Поток: claude-lead-1»${A.adopt.map((x) => ' или «Поток: ' + x).join('')} (эти потоки тимлид забрал себе — их PR дорабатываем сами).
C) Ничего — kind "none". Остальные поля — пустые строки, 0 или false.`,
    { label: 'поиск работы', phase: 'Ревью', model: 'haiku', effort: 'low', schema: SCOUT_SCHEMA })
}

async function trainFix(s) {
  const item = { pr: s.pr, branch: s.branch, lead: s.lead, t: { task: s.task, effort: s.effort, executor: s.executor }, worktree: null }
  const rec = { pr: s.pr, task: s.task, kind: 'trainfix', reason: s.reason }
  results.push(rec)
  if (!s.lead) { await returnPr(s.pr, [{ file: 'поезд мерджей', problem: s.reason, fix: 'влить свежий dev, разрешить конфликты, добиться зелёного CI' }]); rec.returned = true; return rec }
  const fix = await fixPr(item, [{ file: 'поезд мерджей', problem: `PR не влит: ${s.reason}`, fix: 'влить свежий origin/dev, разрешить конфликты по смыслу обеих сторон, починить красные проверки (последний прогон gate и check), дождаться зелёного CI' }], 'PR не прошёл поезд мерджей')
  rec.fix = fix
  if (fix && !fix.blocking) {
    await agent(`Проверь одной командой, что последние прогоны gate и check у PR #${s.pr} зелёные (bash ${LEAD}/wait-checks.sh ${s.pr}, повторяй до green/red, не дольше 30 минут). green — выполни ${ENQUEUE(s.pr)}. red — ничего не делай. Верни, что вышло.`, { label: `в поезд #${s.pr}`, phase: 'Ревью', model: 'haiku', effort: 'low' })
    log(`#${s.pr}: провал поезда исправлен — снова в поезд`)
  } else log(`#${s.pr}: провал поезда не исправлен — оставляю тимлиду`)
  return rec
}

async function lane(name, seed) {
  if (seed) await seed()
  let empty = 0
  while (empty < 3) {
    const s = await scoutWork()
    if (s && s.kind === 'trainfix' && s.pr && !handledFails.has(s.failLine)) {
      handledFails.add(s.failLine); empty = 0
      if (fixingPrs.has(s.pr)) continue
      fixingPrs.add(s.pr)
      await trainFix(s)
      fixingPrs.delete(s.pr)
      continue
    }
    if (s && s.kind === 'review' && s.pr) {
      if (seen.has(s.pr)) continue
      seen.add(s.pr); empty = 0
      await reviewFlow({ pr: s.pr, branch: s.branch, lead: s.lead, t: { task: s.task, effort: s.effort, executor: s.executor }, worktree: null })
      continue
    }
    if (picked < A.maxTasks) {
      const t = await pickTask()
      if (t && taken.has(t.task)) continue
      if (t && !taken.has(t.task)) {
        taken.add(t.task); picked++; empty = 0
        const impl = await implement(t, null)
        results.push({ lane: name, task: t.task, impl })
        log(`${t.task}: ${impl ? (impl.status === 'pr' ? `PR #${impl.pr} — на ревью другой линии` : impl.status + ' — ' + impl.summary) : 'нет ответа'}`)
        continue
      }
    }
    empty++
    await agent(`Выполни bash ${LEAD}/wait-work.sh (ждёт до 9 минут новый PR «на ревью» или новый провал поезда) и верни его вывод одной строкой.`, { label: 'ожидание работы', phase: 'Ревью', model: 'haiku', effort: 'low' })
  }
}

// ---------- затравки: продолжение остановленного ----------
const seeds = A.seeds.map((sd) => async () => {
  if (sd.kind === 'fix') {
    seen.add(sd.pr)
    fixingPrs.add(sd.pr)
    const item = { pr: sd.pr, branch: sd.branch, lead: true, t: { task: sd.task, effort: sd.effort, executor: 'sonnet-5.5' }, worktree: sd.worktree }
    const rec = { pr: sd.pr, task: sd.task, kind: 'fix-seed' }
    results.push(rec)
    await fixLoop(item, sd.issues, 'замечания ревью тимлида (прошлый агент остановлен посреди доработки)', rec)
    fixingPrs.delete(sd.pr)
  } else if (sd.kind === 'task') {
    taken.add(sd.task)
    const impl = await implement({ task: sd.task, executor: sd.executor, effort: sd.effort }, sd.worktree)
    results.push({ task: sd.task, impl })
    log(`${sd.task}: ${impl ? (impl.status === 'pr' ? `PR #${impl.pr} — на ревью другой линии` : impl.status + ' — ' + impl.summary) : 'нет ответа'}`)
  }
})

const lines = []
for (let i = 0; i < A.lanes; i++) lines.push(lane(`l${i + 1}`, seeds[i] || null))
await Promise.all(lines)
return results
