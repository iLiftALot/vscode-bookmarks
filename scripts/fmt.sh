#!/usr/bin/env zsh

set -eo pipefail

typeset -g project_root
project_root="${0:A:h:h}"
cd "$project_root"

typeset -g -a dprintArgs dprintFlags
dprintArgs=(fmt)
dprintFlags=(--config-discovery=default)

_getRelPath() {
  local file_path relpath
  file_path="$1"
  relpath="${file_path#$project_root/}"
  echo "$relpath"
}

callFmt() {
  local output formatted_files exit_code=0 file_path rel_path
  output=$(
    NO_COLOR=1 dprint "${dprintArgs[@]}" "${dprintFlags[@]}" --log-level=debug 2>&1
  ) || exit_code=$?

  if (( exit_code != 0 )); then
    print -ru2 -- "$output"
    return "$exit_code"
  fi

  formatted_files=$(
    print -r -- "$output" |
    rg --pcre2 '\[DEBUG\] Formatted file: (.*\.\w+?) in \d+ms' --replace='$1' |
    awk '!seen[$0]++'
  ) || true

  if [[ -n "$formatted_files" ]]; then
    print -r -- "$formatted_files" | while IFS= read -r file_path; do
      rel_path=`_getRelPath "$file_path"`
      echo "✔︎ ${c_fggreen}Formatted${c_reset}: ${c_fgcyan}${c_bold}${c_underline}/${rel_path}${c_reset}"
    done
  else
    echo "${c_fgyellow}No files needed formatting.${c_reset}"
  fi
}

callCheck() {
  local output exit_code=0 file_path rel_path

  output=$(NO_COLOR=1 dprint "${dprintArgs[@]}" "${dprintFlags[@]}" --list-different) || exit_code=$?

  if (( exit_code != 0 && exit_code != 20 )); then
    return "$exit_code"
  fi

  if [[ -n "$output" ]]; then
    print -r -- "$output" | while IFS= read -r file_path; do
      rel_path=`_getRelPath "$file_path"`
      echo "✔︎ ${c_italic}${c_fgorange}Format?${c_reset}: ${c_fgcyan}${c_bold}${c_underline}/${rel_path}${c_reset}"
    done
  else
    echo "${c_fgyellow}No files needed formatting.${c_reset}"
  fi

  return "$exit_code"
}

callOutput() {
  local raw_output exit_code=0 decimalPlaces index curDecimalPlaces suffix file_path rel_path
  local -a output
  raw_output=$(dprint "${dprintArgs[@]}" "${dprintFlags[@]}") || exit_code=$?

  if (( exit_code != 0 )); then
    return "$exit_code"
  fi

  if [[ -n "$raw_output" ]]; then
    output=("${(@f)$(print -r -- "$raw_output" | sort)}")
    decimalPlaces=$(( ${#${#output}} - 1 ))
    index=1
    print -rl -- "${output[@]}" | while IFS= read -r file_path; do
      curDecimalPlaces=$(( ${#index} ))
      suffix=''
      while (( ${#suffix} < decimalPlaces - curDecimalPlaces + 1 )); do
        suffix+=' '
      done
      rel_path=`_getRelPath "$file_path"`
      echo "$suffix$index. ${c_fggreen}✔︎${c_reset} ${c_fgcyan}${c_bold}${c_underline}/${rel_path}${c_reset}"

      (( index++ ))
    done
  else
    echo "${c_fgyellow}No files needed formatting.${c_reset}"
  fi
}

# $# = number of arguments passed
# $@ = arguments as list
# ${<array_var>[(Ie)<string>]} = retrieve index of matched string in array
if (( $# > 0 )); then
  firstArg="$1"

  case "$firstArg" in
    fmt|check|help|output-file-paths|file-paths)
      dprintArgs=("$@")
      ;;
    output)
      dprintArgs=("$@")
      dprintArgs[1]=output-file-paths
      ;;
    *)
      dprintArgs+=("$@")
      ;;
  esac
fi

# printf 'Received %d argument(s):\n' "$#"
# printf '  %q\n' "$@"

printf 'Running dprint with %d argument(s):\n' "${#dprintArgs[@]}"
printf '  %q\n' "${dprintArgs[@]}"
printf '\n'

case "${dprintArgs[1]}" in
  fmt)
    callFmt
    ;;
  check)
    callCheck
    ;;
  output-file-paths | file-paths)
    callOutput
    ;;
  help)
    dprint "${dprintArgs[@]}"
    ;;
  *)
    printf 'Unsupported dprint command: %s\n' "${dprintArgs[1]}" >&2
    exit 1
    ;;
esac
