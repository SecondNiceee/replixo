export const OPERATOR = {
  fullName: "Титов Николай Константинович",
  shortName: "Титов Н. К.",
  status: "Плательщик налога на профессиональный доход (самозанятый)",
  inn: "774350458937",
  // TODO: проверьте, что ящик существует и вы его читаете.
  email: "support@replixo.ru",
  site: "https://replixo.ru",
} as const

export const LEGAL_UPDATED_AT = "10 октября 2026 г."

export const LEGAL_LINKS = [
  { href: "/terms", label: "Пользовательское соглашение" },
  { href: "/privacy", label: "Политика конфиденциальности" },
  { href: "/consent", label: "Согласие на обработку данных" },
] as const
