#!/usr/bin/env node
import { compile } from "html-to-text";
import readline from "readline";
import chalk from "chalk";
import fetch from "node-fetch";
import { encode } from "gpt-3-encoder";
import * as dotenv from "dotenv";
dotenv.config();

const { env } = process;
const OPENAI_API_KEY = env.OPENAI_API_KEY;
const GOOGLE_SEARCH_API_KEY = env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_ID = env.GOOGLE_SEARCH_ID;

if (!OPENAI_API_KEY || !GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_ID) {
  console.error(
    "Please ensure you set up your .env file with the correct API keys"
  );
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const convert = compile({
  preserveNewlines: false,
  wordwrap: false,
  // The main content of a website will typically be found in the main element
  baseElements: { selectors: ["main"] },
  selectors: [
    {
      selector: "a",
      options: { ignoreHref: true },
    },
  ],
});

async function startCli() {
  rl.question(
    chalk.bgHex("#00A67E").white("🧠 Ask me anything:") + " ",
    async (userPrompt) => {
      await searchGPT(userPrompt);
      startCli();
    }
  );
}

async function searchGPT(userPrompt) {
  process.stdout.write(chalk.dim("> Starting Google Search..."));

  // Step 1: perform Google Search
  // We crawl the first 5 pages returned from Google Search as it often contains the result of the query.
  // As a fallback, we also include all snippets from other search result pages in case the answer is not
  // included in the crawled page already.
  const searchResults = await getGoogleSearchResults(userPrompt);
  const [context, urlReference] =
    (await getTextOfSearchResults(searchResults)) || [];

  // Step 2: build up chat messages by providing search result context and user prompt
  const chatMessages = [
    {
      role: "system",
      content: `You are my AI assistant and I want you to assume today is ${new Date().toDateString()}.`,
    },
    {
      role: "assistant",
      content: context,
    },
    {
      role: "user",
      content: `With the information in the assistant's last message, answer this in the same language: ${userPrompt}`,
    },
  ];

  // Step 2: reach out to OpenAI to answer original user prompt with attached context
  const finalResponse = await getOpenAIChatCompletion(chatMessages);

  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);

  console.log("\n" + chalk.green("> ") + chalk.white(finalResponse));
  console.log(chalk.dim(`> Know more: ${urlReference}` + "\n"));

  return finalResponse;
}

/**
 * Crawl the first page of Google Search results and get the main content
 * If the first page is not accessible, try the next page and so on.
 */
async function getTextOfSearchResults(searchResults) {
  try {
    let urlReference = "";

    // Get all Google Search snippets, clean them up by removing "..." and add to the text context
    let context = searchResults.items.reduce(
      (allPages, currentPage) =>
        `${allPages} ${currentPage.snippet.replaceAll("...", " ")}`,
      ""
    );

    // Loop over searchResults.items until we find a page that is accessible, break if we try more than 5 pages or we reached the end of searchResults.items
    for (let i = 0; i < searchResults.items.length && i < 5; i++) {
      const urlToCheck = searchResults.items[i].link;

      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(chalk.dim(`> Checking: ${urlToCheck}`));

      // Fetch the HTML of the page & get main content. If we get a non 200-code, we try the next page.
      // if fetch request gets stuck for more than 5 seconds, we try the next page.
      const response = await Promise.race([
        fetch(urlToCheck),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 5000)),
      ]);

      if (!response?.ok) {
        continue;
      }

      // Get the full text from the raw HTML and remove any new lines from it as we don't need them
      const fullText = convert(await response.text())
        .replaceAll("\n", " ")
        .trim();
      context = fullText + context;
      urlReference = urlToCheck;

      break;
    }

    // We must stay below the max token amount of OpenAI's API.
    // "Depending on the model used, requests can use up to 4096 tokens shared between prompt and completion"
    // Therefore, the following will allow 3000 tokens for the prompt and the rest for the completion.
    // - https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them
    // - https://platform.openai.com/docs/api-reference/chat/create
    // Note: the following encodes for GPT-3, hence, is only an approximation for other models.
    const maxPromptTokenLength = 3000;
    const encoded = encode(context);

    if (encoded.length > maxPromptTokenLength) {
      context = context.slice(0, maxPromptTokenLength);
    }

    return [context, urlReference];
  } catch (error) {
    console.error(error);
  }
}

/**
 * Fetch the first page of Google Search results
 */
async function getGoogleSearchResults(searchTerm) {
  const response = await makeFetch(
    `https://www.googleapis.com/customsearch/v1\?key\=${GOOGLE_SEARCH_API_KEY}\&cx=${GOOGLE_SEARCH_ID}\&q\=${searchTerm}`
  );
  const data = await response.json();
  return data;
}

/**
 * Call OpenAI's chat API to answer the user's prompt with the context from Google Search
 */
async function getOpenAIChatCompletion(previousChat) {
  const response = await makeFetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: previousChat,
      }),
    }
  );

  const { choices } = await response.json();
  return choices[0].message.content;
}

/**
 * Helper function to make fetch requests
 */
async function makeFetch(url, options) {
  try {
    const response = await fetch(url, options);
    // The Promise returned from fetch() won’t reject on HTTP error status even if the response is an HTTP 404 or 500.
    if (response.ok) {
      return response;
    }
    // for all other status codes (e.g., 404, 500), this will log the error and stop the e2e tests
    console.error(
      `The ${options.method} ${url}" request failed with code: ${response.status} and message: ${response.statusText}`
    );
  } catch (error) {
    // if the request is rejected due to e.g., network failures, this will log the error
    console.error(
      `The ${options.method} ${url}" request failed due to a network error`,
      error
    );
  }
}

startCli();
