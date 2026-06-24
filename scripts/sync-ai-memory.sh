#!/usr/bin/env bash
#
# Актуализация docs/ai-memory/ — снимка персистентной памяти Claude по проекту,
# который читают другие нейросетевые модели.
#
# Что делает:
#   - находит «живую» папку памяти (~/.claude/projects/<encoded-repo-path>/memory)
#   - копирует из неё все *.md в docs/ai-memory/ (перезаписывая)
#   - удаляет из docs/ai-memory/ те *.md, которых в источнике больше нет
#     (README.md — служебный файл репозитория — НИКОГДА не трогается)
#   - проверяет результат на похожие-на-секреты строки и предупреждает
#
# Запуск:   bash scripts/sync-ai-memory.sh
# Источник можно переопределить: CLAUDE_MEMORY_DIR=/path bash scripts/sync-ai-memory.sh
#
set -euo pipefail

# --- Пути -------------------------------------------------------------------
# Корень репозитория (через git, с откатом на расположение скрипта).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "${SCRIPT_DIR%/*}")"

DEST="$REPO_ROOT/docs/ai-memory"

# Папка памяти Claude кодируется как абсолютный путь репо с заменой "/" на "-".
ENCODED="$(printf '%s' "$REPO_ROOT" | sed 's#/#-#g')"
SRC="${CLAUDE_MEMORY_DIR:-$HOME/.claude/projects/$ENCODED/memory}"

# --- Проверки ---------------------------------------------------------------
if [[ ! -d "$SRC" ]]; then
  echo "✗ Источник памяти не найден: $SRC" >&2
  echo "  Укажите путь вручную: CLAUDE_MEMORY_DIR=/путь bash scripts/sync-ai-memory.sh" >&2
  exit 1
fi

shopt -s nullglob
src_files=("$SRC"/*.md)
if [[ ${#src_files[@]} -eq 0 ]]; then
  echo "✗ В источнике нет *.md файлов: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"

# --- Синхронизация ----------------------------------------------------------
added=0; updated=0; removed=0

# 1) Копируем актуальные файлы (added/updated)
for f in "${src_files[@]}"; do
  base="$(basename "$f")"
  if [[ ! -f "$DEST/$base" ]]; then
    cp "$f" "$DEST/$base"; added=$((added+1)); echo "  + $base"
  elif ! cmp -s "$f" "$DEST/$base"; then
    cp "$f" "$DEST/$base"; updated=$((updated+1)); echo "  ~ $base"
  fi
done

# 2) Удаляем устаревшие копии (есть в DEST, нет в SRC), кроме README.md
for d in "$DEST"/*.md; do
  base="$(basename "$d")"
  [[ "$base" == "README.md" ]] && continue
  if [[ ! -f "$SRC/$base" ]]; then
    rm -f "$d"; removed=$((removed+1)); echo "  - $base (удалён, нет в источнике)"
  fi
done

echo "Готово: добавлено $added, обновлено $updated, удалено $removed."
echo "Источник: $SRC"
echo "Назначение: $DEST"

# --- Проверка на секреты ----------------------------------------------------
# Реальные коды вебхука / длинные токены не должны попадать в снимок.
SECRET_RE='rest/[0-9]+/[A-Za-z0-9]{8,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|(secret|token|password|api[_-]?key)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/_+.-]{16,}'
if hits="$(grep -rinE "$SECRET_RE" "$DEST" --include='*.md' 2>/dev/null)"; then
  echo "" >&2
  echo "⚠ Возможные секреты в снимке — проверьте перед коммитом:" >&2
  echo "$hits" >&2
fi
