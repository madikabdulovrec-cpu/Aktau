"""
Аудит соответствия LESSONS[i] ↔ LESSON_CONTENTS[i] в upload_academy/index.html.

Извлекает:
  • массив LESSONS — каждый объект имеет .title
  • массив LESSON_CONTENTS — каждый элемент — backtick-string с HTML

Сравнивает LESSONS[i].title с первым <h3> в LESSON_CONTENTS[i] и
печатает все расхождения.
"""

import re
from pathlib import Path

HTML = Path(r"C:\Users\Madiyar\Desktop\клод проекты\Атырау\upload_academy\index.html").read_text(encoding="utf-8")

# === 1. Извлечь LESSONS title-ы ===
# Каждый элемент в формате: { module:N, title:'X', desc:'...', task:'...' }
lessons_start = HTML.find("const LESSONS = [")
lessons_end = HTML.find("];", lessons_start)
lessons_block = HTML[lessons_start:lessons_end + 2]

# Title может быть в одиночных или двойных кавычках; внутри возможны экранированные кавычки
title_re = re.compile(r"\{\s*module:\d+\s*,\s*title:\s*'([^']*)'")
titles = title_re.findall(lessons_block)
print(f"LESSONS: найдено {len(titles)} заголовков\n")

# === 2. Извлечь LESSON_CONTENTS ===
contents_start = HTML.find("const LESSON_CONTENTS = [")
contents_end = HTML.find("];", contents_start)
contents_block = HTML[contents_start:contents_end + 2]

# Каждый элемент — обёрнутая в backticks многострочная строка.
# Разделители между элементами — `,\n  ` или просто запятая+перевод+бэктик.
# Найдём все backtick-блоки.
# Backticks escape — `\`` маловероятен в нашем тексте, но обработаем чисто:
items = []
i = 0
n = len(contents_block)
while i < n:
    if contents_block[i] == "`":
        j = i + 1
        while j < n:
            if contents_block[j] == "`":
                break
            if contents_block[j] == "\\" and j + 1 < n:
                j += 2
                continue
            j += 1
        items.append(contents_block[i + 1:j])
        i = j + 1
    else:
        i += 1

print(f"LESSON_CONTENTS: найдено {len(items)} элементов\n")

# === 3. Сравнить ===
# Из каждого content вытащим текст первого <h3>...</h3>
h3_re = re.compile(r"<h3[^>]*>(.*?)</h3>", re.DOTALL)

def normalize(s: str) -> str:
    # убрать html-теги, лишние пробелы, эмодзи и пунктуацию для grubbing-match
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s)
    s = s.strip().strip("✨💪🔹❄️🔥🌟😊🤝🎯💼📚🧠👩‍⚕️")
    return s.lower()

def short(s: str, n: int = 80) -> str:
    s = s.strip().replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"

def first_text(html: str) -> str:
    """Первый блок текста из контента — пробуем h3/h4/h5, потом первый <p>."""
    for tag in ("h3", "h4", "h5", "p"):
        m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", html, re.DOTALL)
        if m:
            return m.group(1)
    return html[:200]

mismatches = []
for idx, title in enumerate(titles):
    content = items[idx] if idx < len(items) else ""
    head_text = first_text(content)
    head_norm = normalize(head_text)
    title_norm = normalize(title)
    # Берём ключевые слова из title (длинее 4 символов) и считаем, сколько встречается
    # в первых 800 символах текста content
    head_full_norm = normalize(content[:1500])
    title_words = [w for w in re.findall(r"\w+", title_norm, re.UNICODE) if len(w) >= 4]
    if not title_words:
        continue
    hit = sum(1 for w in title_words if w in head_full_norm)
    if hit < max(1, len(title_words) // 2):
        mismatches.append((idx, title, short(head_text, 80), short(content, 150)))

if not mismatches:
    print("OK: Все 86 уроков совпадают по заголовку с содержимым.")
else:
    print(f"MISMATCH: Найдено {len(mismatches)} расхождений:\n")
    for idx, title, h3, sample in mismatches:
        print(f"  Урок #{idx + 1} (idx={idx})")
        print(f"     LESSONS.title:        {title}")
        print(f"     LESSON_CONTENTS h3:   {h3}")
        print(f"     Sample:               {sample}")
        print()
