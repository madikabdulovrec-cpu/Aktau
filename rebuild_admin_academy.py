r"""
Собирает контент «Академия администратора» из C:\Users\Madiyar\Desktop\клод проекты\Атырау\обучение админа\

Строит два JSON-файла:
  admin_lessons.json     — метаданные (title, module, order) для каждого урока
  admin_contents.json    — HTML-контент каждого урока

Всё это потом встраивается в upload_academy/index.html как
LESSONS_ADMIN и LESSON_CONTENTS_ADMIN. Отдельный документ «Регламент
работы админа» встраивается как ADMIN_REGULATION (большая справочная
статья, доступна в отдельной модалке).
"""

import os
import re
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

try:
    from docx import Document
except ImportError:
    print("Install python-docx: pip install python-docx")
    sys.exit(1)

ROOT = Path(r"C:\Users\Madiyar\Desktop\клод проекты\Атырау")
SRC = ROOT / "обучение админа"

# === Логическая группировка уроков по 5 модулям ===
# Каждая запись: (номер_из_файла, module_idx, короткий_title, описание_ключа, задание)
LESSONS_META = [
    # Module 0: Философия и мышление (5 уроков)
    (1,  0, "Философия сервиса",
        "Основа сервисного мышления администратора M&M",
        "Опишите 3 принципа сервисной философии M&M и приведите пример из практики."),
    (2,  0, "Кодекс Администратора",
        "Свод правил и ценностей администратора",
        "Перечислите ключевые пункты Кодекса и объясните, почему каждый важен."),
    (3,  0, "Искусство гостеприимства",
        "Как встретить клиента, чтобы он захотел вернуться",
        "Опишите идеальную первую минуту клиента в центре — от порога до кабинета."),
    (4,  0, "Стандарт мышления администратора",
        "Установки, которые отличают отличного администратора",
        "Приведите 5 внутренних установок администратора-профессионала."),
    (6,  0, "Главная задача администратора",
        "Что важнее всего в работе — приоритеты",
        "Сформулируйте главную задачу администратора и объясните её через SMART."),

    # Module 1: Стандарты работы (6 уроков)
    (7,  1, "Взаимодействие с мастерами",
        "Как работать с командой мастеров — коммуникация и координация",
        "Опишите 3 сценария конфликта администратор ↔ мастер и стратегии их решения."),
    (8,  1, "Стандарты внешнего вида",
        "Дресс-код, макияж, гигиена — сервисные требования",
        "Составьте чек-лист внешнего вида администратора перед сменой (10 пунктов)."),
    (9,  1, "Управление атмосферой",
        "Как создать атмосферу в центре — свет, звук, ароматы, температура",
        "Опишите свою утреннюю рутину подготовки атмосферы (шаг за шагом)."),
    (15, 1, "Чек-лист",
        "Основной чек-лист смены администратора",
        "Составьте свой чек-лист смены на основе стандарта M&M."),
    (16, 1, "Стандарт обхода",
        "Регламент обхода центра — периодичность и последовательность",
        "Опишите маршрут обхода центра и что вы проверяете на каждой точке."),
    (21, 1, "Идеальный рабочий день администратора",
        "От открытия до закрытия — по часам",
        "Опишите структуру своего идеального рабочего дня по часам."),

    # Module 2: Работа с клиентами (7 уроков)
    (17, 2, "Сопровождение клиента",
        "Как вести клиента через весь путь визита",
        "Опишите этапы сопровождения клиента от записи до выхода из центра."),
    (22, 2, "Продление курсов и удержание",
        "Как продлевать курсы и удерживать клиентов на регулярной основе",
        "Составьте скрипт разговора о продлении курса после последней процедуры."),
    (23, 2, "Психология клиента",
        "Что нужно клиенту на самом деле — эмоции vs факты",
        "Приведите примеры невысказанных потребностей клиента и как их распознать."),
    (24, 2, "Типология клиента",
        "4 типа клиентов и подход к каждому",
        "Опишите 4 типа клиентов и стратегию взаимодействия для каждого."),
    (25, 2, "Работа с конфликтами и жалобами",
        "Как правильно принимать жалобы и переводить конфликт в решение",
        "Опишите 3-шаговый алгоритм отработки жалобы клиента."),
    (26, 2, "Как создать Вау-эффект",
        "Мелочи, которые превращают клиента в фаната",
        "Перечислите 10 идей Вау-эффекта, которые можно внедрить сразу."),
    (28, 2, "Работа с отзывами",
        "Сбор, обработка, ответы на отзывы (Гугл/2ГИС/Инст)",
        "Составьте шаблон ответа на негативный отзыв в 2ГИС."),

    # Module 3: Продажи и выручка (5 уроков)
    (10, 3, "LTV клиента",
        "Life Time Value — как считать и увеличивать",
        "Посчитайте LTV клиента, который посещает центр раз в месяц 6 месяцев подряд."),
    (11, 3, "Сервисные продажи",
        "Продажи через заботу, а не через давление",
        "Опишите разницу между «продажей» и «сервисной продажей» на конкретных примерах."),
    (12, 3, "Главные ошибки администратора",
        "ТОП-10 типовых ошибок и как их избежать",
        "Приведите 5 своих ошибок из практики и способы их исправления."),
    (18, 3, "Работа с возражениями",
        "«Дорого», «подумаю», «не сейчас» — скрипты",
        "Составьте свои ответы на 3 самых частых возражения клиентов."),
    (27, 3, "Влияние администратора на выручку",
        "Как администратор напрямую влияет на кассу центра",
        "Приведите 3 конкретных действия, которые увеличат вашу личную выручку на 20%."),

    # Module 4: Управление процессами (4 урока)
    (13, 4, "Система оценки",
        "Как оценивают работу администратора — KPI и метрики",
        "Опишите свои KPI и объясните, какие действия влияют на каждый."),
    (14, 4, "Восстановление сервиса",
        "Что делать, если что-то пошло не так — service recovery",
        "Опишите алгоритм действий при сбое (например, мастер опоздал на 30 минут)."),
    (19, 4, "Стандарт повторной записи",
        "Как правильно записывать на повторный визит",
        "Составьте скрипт разговора о повторной записи после первой процедуры."),
    (20, 4, "Контроль доходимости",
            "Как обеспечивать высокий процент доходимости клиентов",
            "Опишите систему напоминаний за 24 часа до визита."),
]

# === Маппинг номер файла → путь ===
def find_file(num):
    """Ищет файл, начинающийся с num, в SRC/."""
    for f in SRC.iterdir():
        if not f.is_file() or f.suffix.lower() != '.docx':
            continue
        # Файл может называться "1,Философия…docx" или "10, LTV.docx"
        m = re.match(r'^(\d+)[.,]?\s?', f.name)
        if m and int(m.group(1)) == num:
            # Игнорируем дубликаты с "(1)" в конце
            if '(1)' in f.name:
                # Есть ли версия без "(1)"?
                alt = f.parent / f.name.replace(' (1)', '')
                if alt.exists():
                    continue
            return f
    return None

# === Парсер .docx → HTML ===
def docx_to_html(path):
    if not path or not path.exists():
        return f'<p><em>Материал урока временно недоступен.</em></p>'
    try:
        doc = Document(str(path))
    except Exception as e:
        return f'<p>Ошибка чтения {path.name}: {e}</p>'

    parts = []
    in_list = False
    def close_list():
        nonlocal in_list
        if in_list:
            parts.append('</ul>')
            in_list = False

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        style = (para.style.name if para.style else '').lower()

        if 'heading 1' in style or 'title' in style:
            close_list()
            parts.append(f'<h3>{text}</h3>')
        elif 'heading 2' in style:
            close_list()
            parts.append(f'<h4>{text}</h4>')
        elif 'heading 3' in style or 'heading 4' in style:
            close_list()
            parts.append(f'<h5>{text}</h5>')
        elif 'list' in style or text.startswith(('•','-','–','—','·')):
            clean = re.sub(r'^[•\-–—·]\s*', '', text)
            if not in_list:
                parts.append('<ul>')
                in_list = True
            parts.append(f'<li>{clean}</li>')
        else:
            close_list()
            if len(text) < 80 and text == text.upper() and len(text) > 3:
                parts.append(f'<h4>{text}</h4>')
            else:
                formatted = ''
                for run in para.runs:
                    t = run.text.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
                    if not t:
                        continue
                    if run.bold and run.italic:
                        formatted += f'<strong><em>{t}</em></strong>'
                    elif run.bold:
                        formatted += f'<strong>{t}</strong>'
                    elif run.italic:
                        formatted += f'<em>{t}</em>'
                    else:
                        formatted += t
                if not formatted:
                    formatted = text
                parts.append(f'<p>{formatted}</p>')
    close_list()
    return '\n'.join(parts)

# === Собираем ===
lessons_out = []
contents_out = []
missing = []

for i, (num, mod_idx, title, desc, task) in enumerate(LESSONS_META):
    fp = find_file(num)
    if fp is None:
        missing.append((num, title))
        contents_out.append(f'<p><em>Материал урока #{num} не найден в папке.</em></p>')
        print(f'  [{i+1:2d}/{len(LESSONS_META)}] MISSING #{num}: {title}')
    else:
        html = docx_to_html(fp)
        contents_out.append(html)
        print(f'  [{i+1:2d}/{len(LESSONS_META)}] OK #{num}: {title} ({len(html)} chars)')

    lessons_out.append({
        'module': mod_idx,
        'title': title,
        'desc': desc,
        'task': task,
        'sourceNum': num,
    })

# Дополнительно: Регламент как отдельный документ
reg_path = SRC / 'Регламент работы админа.docx'
regulation_html = docx_to_html(reg_path) if reg_path.exists() else '<p>Регламент не найден.</p>'
print(f'\nРегламент: {"OK" if reg_path.exists() else "MISSING"} ({len(regulation_html)} chars)')

# Записываем
(ROOT / 'admin_lessons.json').write_text(
    json.dumps(lessons_out, ensure_ascii=False, indent=2), encoding='utf-8'
)
(ROOT / 'admin_contents.json').write_text(
    json.dumps(contents_out, ensure_ascii=False, indent=2), encoding='utf-8'
)
(ROOT / 'admin_regulation.json').write_text(
    json.dumps({'html': regulation_html}, ensure_ascii=False, indent=2), encoding='utf-8'
)

print(f'\nВсего уроков: {len(lessons_out)}')
if missing:
    print(f'НЕ НАЙДЕНО файлов: {len(missing)}')
    for num, title in missing:
        print(f'  #{num}: {title}')
print('\nJSON записаны: admin_lessons.json, admin_contents.json, admin_regulation.json')
