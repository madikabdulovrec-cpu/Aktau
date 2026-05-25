"""
Полный rebuild LESSON_CONTENTS[86] в правильном порядке.

Для каждого LESSONS[i] (с реальным title) указан конкретный .docx-файл.
Скрипт:
  1) парсит каждый .docx в HTML (через python-docx)
  2) собирает массив из 86 элементов в порядке LESSONS
  3) переписывает блок `const LESSON_CONTENTS = [ ... ];` в index.html

После прогона все 86 заголовков уроков будут совпадать со своим контентом.
"""

import os
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

try:
    from docx import Document
except ImportError:
    print("Install python-docx first: pip install python-docx")
    sys.exit(1)

ROOT = Path(r"C:\Users\Madiyar\Desktop\клод проекты\Атырау")
HTML_PATH = ROOT / "upload_academy" / "index.html"
URO = ROOT / "уроки"
NOV = ROOT / "новый файлы"

# === MAPPING: 86 уроков, в порядке LESSONS[] ===
LESSON_FILES = [
    # Module 0: Стандарты и сервис M&M (6)
    NOV / "ДНК массажиста.docx",
    NOV / "Культура общения.docx",
    NOV / "Правильное общение с клиентами .docx",
    NOV / "Регламент внешнего вида мастера.docx",
    NOV / "Регламент и правила сервиса.docx",
    NOV / "Скрипт встреча клиента.docx",
    # Module 1: Карьерный путь M&M (5)
    NOV / "1 категория.docx",
    NOV / "2 категория.docx",
    NOV / "3 категория.docx",
    NOV / "4 категория.docx",
    NOV / "5 категория.docx",
    # Module 2: Основы знаний (22)
    URO / "Основы знаний" / "Целлюлит.docx",          # <- ВНИМАНИЕ: файла может не быть
    URO / "Основы знаний" / "Жировая ткань.docx",
    URO / "Основы знаний" / "Лимфатическая система.docx",
    URO / "Основы знаний" / "Составление протоколов.docx",
    URO / "Основы знаний" / "Класификация методик.docx",
    URO / "Основы знаний" / "Этика и психология.docx",
    URO / "Основы знаний" / "Дряблая кожа.docx",
    URO / "Основы знаний" / "Синяки.docx",
    URO / "Основы знаний" / "ЛИпидема.docx",
    URO / "Основы знаний" / "Клиенты после липосакции.docx",
    URO / "Основы знаний" / "Липолитические методики.docx",
    URO / "Основы знаний" / "Массаж при диабете.docx",
    URO / "Основы знаний" / "Работа с гипертониками.docx",
    URO / "Основы знаний" / "Работа с гипотериозом.docx",
    URO / "Основы знаний" / "Работа с инсулинорезистентностьь.docx",
    URO / "Основы знаний" / "Работа при миоме.docx",
    URO / "Основы знаний" / "Работа при наличии камней.docx",
    URO / "Основы знаний" / "Работа при узлах в щитовкидке.docx",
    URO / "Основы знаний" / "Работа с мужчинами.docx",
    URO / "Основы знаний" / "Работа с фитнес-бикини.docx",
    URO / "Основы знаний" / "Запоры.docx",
    URO / "Основы знаний" / "Отслеживание динамики снижения веса.docx",
    # Module 3: Ручные техники (10)
    URO / "Ручные техники" / "Антицеллюлитный ручной массаж.docx",
    URO / "Ручные техники" / "Моделирующий массаж.docx",
    URO / "Ручные техники" / "МЕДОВЫЙ МАССАЖ.docx",
    URO / "Ручные техники" / "сАМУРАЙСКИЙ МАССАЖ.docx",
    URO / "Ручные техники" / "Бразильская выкатка.docx",
    URO / "Ручные техники" / "ИММТ.docx",
    URO / "Ручные техники" / "Блэйд.docx",
    URO / "Ручные техники" / "Золотое Сечение.docx",
    URO / "Ручные техники" / "Хлопковы массаж.docx",
    URO / "Ручные техники" / "Скрабирвание.docx",
    # Module 4: Аппаратные методики (19) — порядок СОГЛАСНО LESSONS
    URO / "Аппаратка" / "LPG массаж.docx",
    URO / "Аппаратка" / "Вакуумный массаж.docx",
    URO / "Аппаратка" / "Криолиполиз.docx",
    URO / "Аппаратка" / "Миостимуляция.docx",
    URO / "Аппаратка" / "Прессотерапия.docx",
    URO / "Аппаратка" / "Вакуумная Кавитация.docx",
    URO / "Аппаратка" / "Индиба.docx",
    URO / "Аппаратка" / "Биботинг.docx",
    URO / "Аппаратка" / "Квантовый Массаж БЭМ.docx",
    URO / "Аппаратка" / "Ролл Шейпер.docx",
    URO / "Аппаратка" / "Турбо массаж.docx",
    URO / "Аппаратка" / "Магнэтик Про.docx",
    URO / "Аппаратка" / "3D моделирование.docx",
    URO / "Аппаратка" / "Impuls.docx",
    URO / "Аппаратка" / "Биофотон.docx",
    URO / "Аппаратка" / "Кедровая бочка.docx",
    URO / "Аппаратка" / "Термо-одеяло.docx",
    URO / "Аппаратка" / "Трон Кегеля.docx",
    URO / "Аппаратка" / "Сауна.docx",
    # Module 5: Косметология (19) — порядок СОГЛАСНО LESSONS
    URO / "Косметология" / "Гидропилинг.docx",
    URO / "Косметология" / "Карбоновый пилинг.docx",
    URO / "Косметология" / "Пилинги.docx",
    URO / "Косметология" / "Индиба лицо.docx",
    URO / "Косметология" / "ЛПджи лицо.docx",
    URO / "Косметология" / "Вакуумный массаж лица.docx",
    URO / "Косметология" / "Лазерная Эпиляция.docx",
    URO / "Косметология" / "Микроигольчатый.docx",
    URO / "Косметология" / "БМС.docx",
    URO / "Косметология" / "Миостимуляция лицо.docx",
    URO / "Косметология" / "Медовый массаж лица.docx",
    URO / "Косметология" / "Ручная пластика лица.docx",
    URO / "Косметология" / "Бэм лицо.docx",
    URO / "Косметология" / "2Д моделирование.docx",
    URO / "Косметология" / "Тэрмаж.docx",
    URO / "Косметология" / "Озон.docx",
    URO / "Косметология" / "Оксиженео.docx",
    URO / "Косметология" / "Удаление татуажа.docx",
    URO / "Косметология" / "Холодная плазма" / "Холодная Плазма.docx",
    # Module 6: Маски и обёртывания (5)
    URO / "Маски и обертывания" / "Общая информация по маскам.docx",
    URO / "Маски и обертывания" / "БАНДАЖНОЕ ОБЕРТОВАНИЕ.docx",
    URO / "Маски и обертывания" / "Водорослевое обертование.docx",
    URO / "Маски и обертывания" / "Гипсомоделирование.docx",
    URO / "Маски и обертывания" / "Грязевые маски.docx",
]

assert len(LESSON_FILES) == 86, f"Должно быть 86 файлов, есть {len(LESSON_FILES)}"

def docx_to_html(path: Path) -> str:
    if not path.exists():
        return f"<p><em>Контент урока временно недоступен (файл не найден: {path.name}).</em></p>"
    try:
        doc = Document(str(path))
    except Exception as e:
        return f"<p>Ошибка загрузки {path.name}: {e}</p>"

    parts = []
    in_list = False

    def close_list():
        nonlocal in_list
        if in_list:
            parts.append("</ul>")
            in_list = False

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        style = (para.style.name if para.style else "").lower()

        if "heading 1" in style or "title" in style:
            close_list()
            parts.append(f"<h3>{text}</h3>")
        elif "heading 2" in style:
            close_list()
            parts.append(f"<h4>{text}</h4>")
        elif "heading 3" in style or "heading 4" in style:
            close_list()
            parts.append(f"<h5>{text}</h5>")
        elif "list" in style or text.startswith(("•", "-", "–", "—", "·")):
            clean = re.sub(r"^[•\-–—·]\s*", "", text)
            if not in_list:
                parts.append("<ul>")
                in_list = True
            parts.append(f"<li>{clean}</li>")
        else:
            close_list()
            if len(text) < 80 and text == text.upper() and len(text) > 3:
                parts.append(f"<h4>{text}</h4>")
            else:
                # Inline formatting via runs
                formatted = ""
                for run in para.runs:
                    t = run.text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    if not t:
                        continue
                    if run.bold and run.italic:
                        formatted += f"<strong><em>{t}</em></strong>"
                    elif run.bold:
                        formatted += f"<strong>{t}</strong>"
                    elif run.italic:
                        formatted += f"<em>{t}</em>"
                    else:
                        formatted += t
                if not formatted:
                    formatted = text
                parts.append(f"<p>{formatted}</p>")
    close_list()
    return "\n".join(parts)

# === Build LESSON_CONTENTS ===
print(f"Парсю {len(LESSON_FILES)} .docx файлов...")
contents = []
missing = []
for i, fp in enumerate(LESSON_FILES):
    html = docx_to_html(fp)
    contents.append(html)
    if not fp.exists():
        missing.append((i, fp))
    status = "OK" if fp.exists() else "MISSING"
    print(f"  [{i+1:2d}/{len(LESSON_FILES)}] {status}: {fp.name} ({len(html)} chars)")

if missing:
    print(f"\n{len(missing)} файлов отсутствует:")
    for i, fp in missing:
        print(f"  #{i+1}: {fp}")

# === Записать обратно в HTML ===
html_text = HTML_PATH.read_text(encoding="utf-8")
lc_start = html_text.find("const LESSON_CONTENTS = [")
lc_end = html_text.find("];", lc_start)
assert lc_start >= 0 and lc_end > lc_start, "LESSON_CONTENTS block не найден"

def escape_js_template(s: str) -> str:
    return s.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")

body = "[\n  " + ",\n\n  ".join("`" + escape_js_template(c) + "`" for c in contents) + "\n]"
new_block = "const LESSON_CONTENTS = " + body + ";"

new_html = html_text[:lc_start] + new_block + html_text[lc_end + 2:]
HTML_PATH.write_text(new_html, encoding="utf-8")

print(f"\nГотово. LESSON_CONTENTS перезаписан, 86 элементов в правильном порядке.")
print(f"Если были missing файлы — там подставлен плейсхолдер «контент недоступен».")
