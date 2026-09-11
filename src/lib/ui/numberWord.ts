const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty", "twenty-one", "twenty-two", "twenty-three", "twenty-four",
  "twenty-five", "twenty-six", "twenty-seven", "twenty-eight", "twenty-nine", "thirty",
];

/** "Twelve paragraphs, give or take"; "eleven paragraphs". Falls back to digits
 *  past thirty, which the target-length range never reaches. */
export function numberWord(n: number, { capitalize = false } = {}): string {
  const word = NUMBER_WORDS[n] ?? String(n);
  return capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}
