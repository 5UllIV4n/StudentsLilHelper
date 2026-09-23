const { test, expect } = require('@playwright/test');

const sound = require("sound-play");

const path = require("path");

const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

const CREDENTIALS = {
  username: process.env.ESSENTIAL_ED_USER || "",
  password: process.env.ESSENTIAL_ED_PASS || ""
};

const AUDIO_FILE = path.join(__dirname, "correct.mp3");


async function detectCurrentState(page) {
  // inspect each active frame and identify what kind of interaction is currently available.
  const frames = page.frames().filter(f => f !== page.mainFrame() && !f.url().startsWith('about:blank'));

  for (const frame of frames) {
    try {
      const radios = frame.getByRole('radio');
      if (await radios.count().catch(() => 0) > 0)
        return { frame, type: 'radio', target: radios };

      const textInputs = frame.locator('input[type="text"]:visible, textarea:visible');
      if (await textInputs.count().catch(() => 0) > 0)
        return { frame, type: 'input', target: textInputs.first() };

      // check all known variants rather than relying on one selector.
      const frameNav = frame.locator([
        'button[aria-label="Yes"]:visible',
        'div[aria-label="Yes"][role="button"] button:visible',
        'div[aria-label="Go On"][role="button"]:visible',
        'div[aria-label="Continue"][role="button"]:visible',
        '[aria-label="Continue"][role="graphics-symbol"]:visible',
        'div[aria-label="Next"][role="button"]:visible',
        'div[aria-label="Results"][role="button"]:visible',
        'div[aria-label="Submit"][role="button"]:visible',
        'div[aria-label="Submit Quiz"][role="button"]:visible',
        'div[aria-label="Start"][role="button"]:visible',
        'button.slide-control-button-next:visible',
        'button.slide-control-button-submit:visible',
        'button:has-text("SUBMIT"):visible'
      ].join(','));

      if (await frameNav.count().catch(() => 0) > 0) {
        return { frame, type: 'frameNav', target: frameNav.first() };
      }
    } catch (err) {

    }
  }

  const academyLink = page.getByRole('link', { name: /Academy/i });

  if (
    await academyLink.count().catch(() => 0) > 0 &&
    await academyLink.first().isVisible().catch(() => false)
  ) {
    return { frame: page, type: 'mainNav', target: academyLink.first() };
  }

  const mainNav = page.locator([
    'h4.next-btn:visible',
    'a[data-url*="set-study-location"]:visible',
    'a:has-text("Start Lesson"):visible',
    'a:has-text("Start Quiz"):visible',
    'a:has-text("Next Lesson"):visible',
    'button:has-text("Continue"):visible'
  ].join(','));

  if (await mainNav.count().catch(() => 0) > 0) {
    return { frame: page, type: 'mainNav', target: mainNav.first() };
  }

  return null;
}


async function extractQuestionText(frame) {
  const labeledElements = frame.locator('[aria-label]:visible');
  const count = await labeledElements.count();

  const ignoreList = [
    'Menu',
    'Question',
    'Do not use a calculator',
    'Correct',
    'Incorrect',
    'Skip Navigation',
    'Hit enter to return to the slide',
    'Continue',
    'Submit Quiz',
    'Start'
  ];

  let parts = [];

  for (let i = 0; i < count; i++) {
    const el = labeledElements.nth(i);
    const labelText = await el.getAttribute('aria-label');
    const role = await el.getAttribute('role');

    if (
      labelText &&
      role !== 'radio' &&
      role !== 'graphics-symbol' &&
      !ignoreList.some(phrase => labelText.includes(phrase))
    ) {
      parts.push(labelText.trim());
    }
  }

  return parts.join(' ');
}


test('Automated Continuous Quiz/Lesson Solver', async ({ page }) => {
  test.setTimeout(0);

  console.log("Starting essentialed automation worker...");

  await page.goto('');

  await page.locator('input[name="username"]').waitFor({ state: 'visible' });

  if (CREDENTIALS.username && CREDENTIALS.password) {
    await page.locator('input[name="username"]').fill(CREDENTIALS.username);
    await page.locator('input[name="password"]').fill(CREDENTIALS.password);
    await page.locator('input[type="submit"]').click();
  }

  console.log("Attempting initial dashboard navigation...");

  await page.locator('a[data-url$="set-study-location/1"]').click({ timeout: 5000 }).catch(() => {});
  await page.getByRole('link', { name: /Academy/i }).click({ timeout: 5000 }).catch(() => {});
  await page.locator('h4.next-btn').first().click({ timeout: 5000 }).catch(() => {});

  sound.play(AUDIO_FILE).catch(() => console.log("Audio alert skipped."));

  let idleCount = 0;
  let lastQuestionText = "";

  while (true) {
    const state = await detectCurrentState(page);

    if (!state) {
      idleCount++;

      if (idleCount > 40) {
        console.log("Waiting for new content or manual navigation...");
        idleCount = 0;
      }

      await page.waitForTimeout(250);
      continue;
    }

    idleCount = 0;

    if (state.type === 'mainNav') {
      const text = await state.target.textContent().catch(() => 'Navigation Element');

      console.log(`Clicking page-level button: "${text.trim()}"`);

      await state.target.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }

    if (state.type === 'frameNav') {
      const label =
        await state.target.getAttribute('aria-label').catch(() => '') ||
        await state.target.textContent().catch(() => '');

      console.log(`Clicking frame button: "${label.trim()}"`);

      await state.target.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.type === 'radio' || state.type === 'input') {
      const questionText = await extractQuestionText(state.frame);

      if (questionText && questionText === lastQuestionText) {
        console.log("Still on the same question slide. Forcing slide advance...");

        const feedbackBtn = state.frame.locator([
          'div[aria-label="Continue"][role="button"]:visible',
          '[aria-label="Continue"][role="graphics-symbol"]:visible',
          'div[aria-label="Go On"][role="button"]:visible',
          'div[aria-label="Next"][role="button"]:visible',
          'button.slide-control-button-next:visible'
        ].join(','));

        if (await feedbackBtn.count() > 0) {
          await feedbackBtn.first().click({ force: true }).catch(() => {});
        } else {
          const submit = state.frame.locator(
            'button.slide-control-button-submit:visible, ' +
            'button:has-text("SUBMIT"):visible, ' +
            'div[aria-label="Submit"][role="button"]:visible'
          );

          if (await submit.count() > 0) {
            await submit.first().click({ force: true }).catch(() => {});
          }
        }

        await page.waitForTimeout(1000);
        continue;
      }

      lastQuestionText = questionText;

      console.log(`\nDetected New Question: ${questionText}`);

      try {
        if (state.type === 'radio') {
          const choicesCount = await state.target.count();
          let options = [];

          for (let i = 0; i < choicesCount; i++) {
            options.push(await state.target.nth(i).getAttribute('aria-label'));
          }

          const aiPrompt = `
            You are taking a test. Question: ${questionText}
            Choices:
            ${options.map((opt, i) => `${i}:${opt}`).join('\n')}
            Respond ONLY with the single digit index number (0, 1, 2, etc.) of the correct answer.
          `;

          const result = await model.generateContent(aiPrompt);
          const aiResponse = result.response.text().trim();

          const match = aiResponse.match(/\d+/);
          let chosenIndex = match ? parseInt(match[0], 10) : 0;

          // Keep an unexpected AI response from producing an invalid array index.
          if (chosenIndex < 0 || chosenIndex >= choicesCount) chosenIndex = 0;

          console.log(`AI Answer: Choice ${chosenIndex} (${options[chosenIndex]})`);

          await state.target.nth(chosenIndex).click({ force: true });

        } else if (state.type === 'input') {
          const aiPrompt = `
            Question: ${questionText}
            Respond ONLY with the exact short numeric or single-word answer for the input box.
          `;

          const result = await model.generateContent(aiPrompt);

          let aiResponse = result.response.text()
            .trim()
            .replace(/(?<!\d)\.$/, "");

          console.log(`AI Answer: ${aiResponse}`);

          await state.target.fill(aiResponse);
        }

      } catch (err) {
        console.error("AI error, using fallback...");

        if (state.type === 'radio')
          await state.target.first().click({ force: true });
        else
          await state.target.fill("1");
      }

      await page.waitForTimeout(300);

      const submit = state.frame.locator(
        'button.slide-control-button-submit:visible, ' +
        'button:has-text("SUBMIT"):visible, ' +
        'div[aria-label="Submit"][role="button"]:visible'
      );

      if (await submit.count() > 0) {
        await submit.first().click({ force: true }).catch(() => {});
        console.log("Submitted answer.");
      }

      await page.waitForTimeout(1000);

      const feedbackBtn = state.frame.locator([
        'div[aria-label="Continue"][role="button"]:visible',
        '[aria-label="Continue"][role="graphics-symbol"]:visible',
        'div[aria-label="Go On"][role="button"]:visible',
        'div[aria-label="Next"][role="button"]:visible',
        'button.slide-control-button-next:visible'
      ].join(','));

      if (await feedbackBtn.count() > 0) {
        await feedbackBtn.first().click({ force: true }).catch(() => {});
        console.log("Clicked feedback Continue/Next button.");
      }

      await page.waitForTimeout(1000);
    }
  }
});