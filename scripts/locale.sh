# Kept in sync with src/locale.ts; installer tests exercise both resolvers.
i18n_locale() {
  case $(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]_' '[:lower:]-') in
    en|en[-.@]*) printf en;; zh|zh[-.@]*) printf zh;;
    ja|ja[-.@]*) printf ja;; ko|ko[-.@]*) printf ko;;
    ru|ru[-.@]*) printf ru;; c|c[-.@]*|posix|posix[-.@]*) printf en;;
  esac
}
i18n_init() {
  i18n_choice=
  i18n_override=$(printf '%s' "${CORGI_LANG:-}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
  case $i18n_override in
    ''|auto) ;;
    *) i18n_choice=$(i18n_locale "$CORGI_LANG"); i18n_language=${i18n_choice:-en}; return;;
  esac
  i18n_messages=${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}
  case $(printf '%s' "$i18n_messages" | tr '[:upper:]' '[:lower:]') in
    c|c.*|c@*|posix|posix.*|posix@*) i18n_language=en; return;;
  esac
  i18n_list=${LANGUAGE:-}
  while [ -n "$i18n_list" ]; do
    i18n_item=${i18n_list%%:*}
    i18n_choice=$(i18n_locale "$i18n_item")
    [ -z "$i18n_choice" ] || break
    case $i18n_list in *:*) i18n_list=${i18n_list#*:};; *) break;; esac
  done
  if [ -z "$i18n_choice" ] && [ -n "$i18n_messages" ]; then
    i18n_choice=$(i18n_locale "$i18n_messages")
  elif [ -z "$i18n_choice" ] && [ "$(uname -s)" = Darwin ]; then
    i18n_list=$(defaults read -g AppleLanguages 2>/dev/null | tr -cs '[:alnum:]_-' '\n') || i18n_list=
    for i18n_item in $i18n_list; do
      i18n_choice=$(i18n_locale "$i18n_item")
      [ -z "$i18n_choice" ] || break
    done
  fi
  i18n_language=${i18n_choice:-en}
}
