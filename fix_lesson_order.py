"""
Пересортирует LESSON_CONTENTS в upload_academy/index.html так, чтобы
индексы совпадали с LESSONS. Для каждого LESSONS[i].title ищет
наиболее похожий по содержимому элемент LESSON_CONTENTS.

Алгоритм:
  1. Парсит LESSONS — список (idx, title, module).
  2. Парсит LESSON_CONTENTS — список html-строк (86 шт.).
  3. Для каждого LESSONS[i] вычисляет relevance к каждому content[k]
     через пересечение значимых слов (длина >= 4) из title и первых
     ~400 символов содержимого.
  4. Жадно сопоставляет 1:1 (best match first).
  5. Печатает план перестановки.
  6. Если флаг --apply, переписывает HTML с новой расстановкой.
"""

import re
import sys
from pathlib import Path
from collections import Counter

PATH = Path(r"C:\Users\Madiyar\Desktop\клод проекты\Атырау\upload_academy\index.html")
HTML = PATH.read_text(encoding="utf-8")

# ---- LESSONS titles ----
ls_start = HTML.find("const LESSONS = [")
ls_end = HTML.find("];", ls_start)
ls_block = HTML[ls_start:ls_end + 2]
title_re = re.compile(r"\{\s*module:(\d+)\s*,\s*title:\s*'([^']*)'")
lessons = [(int(m), t) for m, t in title_re.findall(ls_block)]
assert len(lessons) == 86, f"LESSONS должно быть 86, найдено {len(lessons)}"

# ---- LESSON_CONTENTS items (массив backtick-обёрнутых строк) ----
lc_start = HTML.find("const LESSON_CONTENTS = [")
lc_end = HTML.find("];", lc_start)
# Где именно начинаются backtick-строки и где они заканчиваются (для replace)
lc_block_full_start = lc_start
lc_block_full_end = lc_end + 2
lc_block = HTML[lc_start:lc_end + 2]

items = []
item_positions = []   # absolute byte positions of each ` ... ` in original HTML
i = 0
n = len(lc_block)
abs_offset = lc_block_full_start
while i < n:
    if lc_block[i] == "`":
        j = i + 1
        while j < n:
            if lc_block[j] == "`":
                break
            if lc_block[j] == "\\" and j + 1 < n:
                j += 2
                continue
            j += 1
        items.append(lc_block[i + 1:j])
        item_positions.append((abs_offset + i, abs_offset + j + 1))
        i = j + 1
    else:
        i += 1

print(f"LESSONS: {len(lessons)}, LESSON_CONTENTS: {len(items)}")
if len(items) != 86:
    print("WARN: количество LESSON_CONTENTS != 86. Не могу гарантировать 1:1 mapping.")

# ---- normalization helpers ----
STOP = {
    "что", "как", "для", "это", "при", "или", "его", "был", "она", "они",
    "так", "уже", "еще", "ещё", "все", "всё", "вот", "тут", "там", "где",
    "тоже", "если", "был", "была", "было", "были", "могут", "может", "которая",
    "который", "которые", "тоже", "только", "очень", "более", "менее",
    "ваш", "ваша", "ваше", "ваши", "наш", "наша", "наше", "наши",
    "после", "перед", "через", "между", "также", "когда", "потом",
    "этом", "этой", "этого", "будет", "будут", "будь", "должен",
    "должна", "массаж", "массажа",  # слишком частое
    "процедура", "процедуры", "процедур",
    "лица", "лицо",
    "тела", "тело",
    "коже", "кожа", "кожи",
    "клиент", "клиента", "клиентов", "клиенту",
    "мастер", "мастера",
    "категория", "категории",
}

def tokens(s: str):
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.lower()
    s = re.sub(r"[^\w\sа-яё]", " ", s, flags=re.UNICODE)
    out = []
    for w in s.split():
        if len(w) >= 4 and w not in STOP:
            out.append(w)
    return out

def score(title: str, content: str) -> float:
    """Похожесть title vs первые ~500 chars content."""
    head = content[:600]
    ct = set(tokens(title))
    cc = Counter(tokens(head))
    if not ct:
        return 0.0
    hit = sum(cc.get(w, 0) for w in ct)
    return hit / max(1, len(ct))

# ---- Жадный matcher ----
# Для каждой пары (lesson_idx, content_idx) посчитаем score
scores = []
for li, (mod, title) in enumerate(lessons):
    for ci, content in enumerate(items):
        s = score(title, content)
        if s > 0:
            scores.append((s, li, ci))
scores.sort(reverse=True)

assigned_lesson = [None] * len(lessons)
assigned_content = [False] * len(items)
for s, li, ci in scores:
    if assigned_lesson[li] is not None:
        continue
    if assigned_content[ci]:
        continue
    assigned_lesson[li] = ci
    assigned_content[ci] = True

# Дозначим оставшиеся (тех, у кого score=0 для всех) — в свободные слоты по порядку
free_contents = [ci for ci, used in enumerate(assigned_content) if not used]
for li in range(len(lessons)):
    if assigned_lesson[li] is None and free_contents:
        ci = free_contents.pop(0)
        assigned_lesson[li] = ci
        assigned_content[ci] = True

# ---- Отчёт ----
print("\nНовое сопоставление (LESSON_idx → content_idx | title → score):")
changed = 0
for li, (mod, title) in enumerate(lessons):
    ci = assigned_lesson[li]
    s = score(title, items[ci]) if ci is not None else 0.0
    marker = "  " if ci == li else "→ "
    if ci != li:
        changed += 1
    print(f"  {marker}#{li+1:2d} (mod {mod}) <- content[{ci+1 if ci is not None else '?':>2}] | {title[:50]:50s} | score={s:.2f}")
print(f"\nИзменено: {changed} из {len(lessons)}")

# ---- Применение ----
if "--apply" in sys.argv:
    new_items = []
    for li in range(len(lessons)):
        ci = assigned_lesson[li]
        new_items.append(items[ci])

    # Восстановим LESSON_CONTENTS блок: `LC[0]`,\n  `LC[1]`,\n  ...
    body = "[\n  " + ",\n\n  ".join("`" + s + "`" for s in new_items) + "\n]"
    new_block = "const LESSON_CONTENTS = " + body + ";"

    new_html = HTML[:lc_start] + new_block + HTML[lc_end + 2:]
    PATH.write_text(new_html, encoding="utf-8")
    print(f"\nЗАПИСАНО в {PATH}: переставлено {changed} элементов")
else:
    print("\nDry run. Чтобы применить: добавь --apply")
