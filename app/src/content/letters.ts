/**
 * Letters for later copy (/letters; plan.md §16.10): personal letters from the estate owner that open at the right
 * moment. af/st/zu live in content/i18n/letters.ts and must translate every key (content/letters.test.ts).
 * Text only: no recorded or copied voices anywhere in this copy.
 */
export const letters = {
  meta: { title: "Letters for later" },
  eyebrow: "Family",
  title: "Letters for *later*",
  line: "Your own words for your family, opened at the right moment.",
  demoNote: "Demo: letters stay in this browser. On the live network they are signed by the owner's wallet and kept off-chain.",
  chainNote: "Letters are signed by Thabo's wallet and never go on the public ledger. Until the family's server store is switched on, a letter is kept on the device that wrote it and on this server.",
  notWill: "This letter is personal. It is not part of your will and does not change who receives what.",
  privacy: "How letters are kept",
  loading: "Loading letters",
  loadError: "Letters could not be loaded.",
  retry: "Try again",

  noRole: {
    title: "Letters are for the family",
    body: "Only the estate's owner and the family members named in the plan can open this page.",
    back: "Back to the estate",
  },
  sealed: "Letters are sealed. Nothing can be added or changed now that the estate has unlocked.",
  paused: "Letters can't be changed while a passing is being confirmed.",

  list: {
    title: "Your letters",
    empty: "No letters yet. Write one for a birthday, a graduation, or for when the plan starts without you.",
    new: "New letter",
    to: "To {name}",
    family: "the whole family",
    familyShort: "Family",
    edit: "Edit",
    delete: "Delete",
    confirmTitle: "Delete this letter?",
    confirmDelete: "It is erased at once and nobody will be able to read it. This can't be undone.",
    confirmCta: "Delete letter",
    cancel: "Keep it",
    deleted: "Letter deleted",
    untitled: "A letter",
    seeded: "Demo letter, added when the demo was set up",
  },

  state: {
    unlock: "Opens when the estate unlocks",
    date: "Opens on {date}",
    payment: "Opens with {name}'s gift, {amount}, due {date}",
    paymentNoDate: "Opens with {name}'s next payment, {amount}",
    send: "Opens when your transfer is confirmed",
    opened: "Opened {date}",
  },

  editor: {
    titleNew: "New letter",
    titleEdit: "Edit letter",
    to: "Who is it for?",
    family: "The whole family",
    familyHint: "Everyone named in the plan can read it once it opens.",
    person: "One person",
    personHint: "Only they can read it.",
    when: "When does it open?",
    whenUnlock: "When the estate unlocks",
    whenDate: "On a date",
    whenDateHint: "At midnight, South African time.",
    whenPayment: "With a payment from the plan",
    whenPaymentHint: "The letter opens with the next payment under this rule.",
    noRules: "{name} has no payment rule yet. Add one in the plan first.",
    familyNoPayment: "A letter to the whole family opens at unlock or on a date.",
    ruleOption: "{category}: {amount}, next due {date}",
    ruleOptionNoDate: "{category}: up to {amount} a payment",
    about: "About (optional)",
    aboutNone: "Nothing in particular",
    occasion: "Occasion (optional)",
    occasionHint: "For example: For your 18th birthday",
    text: "Your letter",
    counter: "{count} of {max}",
    help: "Help me write it",
    check: "Check my letter",
    checking: "Checking",
    save: "Save and sign",
    saved: "Saved and signed",
    ackWarnings: "I have read the warnings",
    cancel: "Cancel",
    tooLong: "Shorten the letter to {max} characters.",
    empty: "Write something first.",
    dateNeeded: "Choose a date after today.",
    ruleNeeded: "Choose the payment it opens with.",
  },

  help: {
    title: "A suggestion",
    label: "A suggestion. Change it into your own words.",
    points: "A few things you want to say (optional)",
    pointsHint: "Short notes are enough: a memory, a hope, a piece of advice.",
    ask: "Suggest a draft",
    asking: "Writing a suggestion",
    use: "Use this",
    dismiss: "No thanks",
    templates: {
      unlock: "{name},\n\nIf you are reading this, the plan is doing what I asked it to do, and I am not there to do my part.\n\n[A memory you share]\n\n[What you hope for them]\n\nLook after each other.\n\n[Your name]",
      date: "{name},\n\n{occasion}. I wrote this long before today, because I wanted to be part of it.\n\n[A memory you share]\n\n[What you hope for them]\n\n[Your name]",
      payment: "{name},\n\nThis gift comes from a plan I made for you. {occasion}.\n\n[What you hope they will do with it]\n\n[Something that makes them laugh]\n\n[Your name]",
      send: "{name},\n\nI sent you this today. {occasion}.\n\n[Why you are sending it]\n\n[Your name]",
    },
  },

  review: {
    title: "What to check",
    none: "Nothing to warn you about. The words are yours to keep or change.",
    intro: "These are warnings, not rules. You can still save.",
    source: {
      rules: "Checked on this device against Heirloom's rules.",
      ai: "Checked against Heirloom's rules and by the AI agent. The AI only suggests; nothing was saved.",
    },
    codes: {
      "secret.password": "This looks like a password. A letter is not a safe place for one: anyone who reads it later can use it.",
      "secret.pin": "This looks like a PIN or a one-time code. Leave it out of the letter.",
      "secret.seed": "This looks like a wallet recovery phrase. Never write one in a letter: whoever reads it controls the wallet.",
      "secret.card": "This looks like a bank card number. Leave it out of the letter.",
      "secret.account": "This looks like a bank account number. Your executor will have what is needed; leave it out of the letter.",
      "secret.idNumber": "This looks like a South African ID number. Leave it out of the letter.",
      "will.asset": "Your plan sells the {asset} and puts the money in the family vault. This letter says it belongs to {name}.",
      "will.amount": "This letter mentions {amount}, but the gift it opens with is {gift}.",
      "will.other": "This letter says the {asset} belongs to {name}, but your plan gives it to someone else. Check that the letter and the plan agree.",
    },
    familyName: "the family",
  },

  read: {
    title: "Letters for you",
    empty: "No letters for you yet.",
    from: "From {name}",
    opened: "Opened {date}",
    about: "About: {asset}",
    gift: "With {amount}, paid {date}",
    giftSimulated: "simulated",
    proof: "See the payment",
    addedBy: "Added by {name}, {year}",
    transcribedBy: "Written by {name} in {year}, typed out by {owner}",
    signed: "Signed by {name}'s wallet on {date} · {hash}",
    demoSigned: "Demo letter, added when the demo was set up",
    print: "Print",
    printed: "Printed from Heirloom on {date}",
  },

  moment: {
    title: "{name} left you a letter",
    body: "{occasion}",
    cta: "Read it",
  },
  nudge: {
    title: "{name} left you a letter",
    cta: "Read the letter",
  },
  card: {
    letters: "{count} letters from {name}",
    letter: "1 letter from {name}",
    read: "Read",
    imagined: "imagined",
  },
  willCard: {
    title: "Letters for later",
    body: "{count} letters, {gifts} with a gift",
    empty: "Leave a few words for a birthday, a graduation, or for when the plan starts without you.",
    cta: "Open letters",
  },
  send: { add: "Add a letter to this gift" },

  errors: {
    forbidden: "Only the estate owner can write letters.",
    paused: "Letters can't be changed while a passing is being confirmed.",
    sealed: "Letters are sealed now that the estate has unlocked.",
    opened: "This letter has opened, so it can no longer be changed. You can still delete it.",
    version: "This letter was changed somewhere else. Reload and try again.",
    tooLarge: "The letter is too long. Shorten it to 2,000 characters.",
    badLetter: "Something in the letter needs fixing.",
    badLink: "That payment rule is not for this person.",
    full: "An estate can keep 50 letters. Delete one to write another.",
    unavailable: "Letters can't be saved on this server right now. Your letters stay on this device.",
    network: "No connection. Your letters stay on this device; try again when you're online.",
    notFamily: "Only the estate's family can read letters.",
  },

  /** The seeded demo letters (plan.md §16.11), so the demo reads in every language. Written 18 Nov 2026. */
  demo: {
    family: {
      occasion: "For all of you",
      text: "To Lerato, Sipho and Naledi. If you are reading this, the plan is doing its work and I am not there to do mine. Look after each other first and the money second. Visit Gogo's grave when you can, and ask Uncle Bongani for the stories I never finished. I am proud of every one of you. Dad",
    },
    lerato: {
      occasion: "About the Corolla",
      text: "Lerato, you learned to drive in the Corolla and stalled it at every robot on Klipspruit Valley Road. The plan sells it so the money keeps paying for your studies and for Sipho and Naledi. Keep the photos, not the car. Drive carefully. Dad",
    },
    naledi: {
      occasion: "For your 18th birthday",
      text: "Naledi, today you are 18. The 500 USD₮ is yours to start something of your own: a course, a laptop, a first month's rent. Spend a little of it on something that makes you laugh. Dad",
    },
    mkhulu: {
      occasion: "About Mkhulu Joseph",
      text: "Mkhulu Joseph left no letter, so these are my words, not his. He built the house in Soweto with his own hands and paid for every school book in cash each January. When you plant something, think of him. Thabo",
    },
  },
};

export type LettersCopy = typeof letters;
/** The seeded demo letters' keys. */
export type DemoLetterKey = keyof LettersCopy["demo"];
