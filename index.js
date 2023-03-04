#!/usr/bin/env node
import { compile } from "html-to-text";
import readline from "readline";
import chalk from "chalk";
import fetch from "node-fetch";
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

// Store any previous chats
let previousChat = [];

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

  previousChat = [
    {
      role: "system",
      content: `You are my AI assistant and I want you to assume today is ${new Date().toDateString()}.`,
    },
  ];

  // Step 1: perform Google Search
  // We crawl the first page returned in the Google Search as it often contains the result of the query.
  // As a fallback, we also include all snippets from the other search result pages in case the answer is not
  // included in the first page already.
  const searchResults = await getGoogleSearchResults(userPrompt);
  const [firstpage, ...remainingPages] = searchResults.items;
  const urlToCheck = firstpage.link;

  process.stdout.cursorTo(0);
  process.stdout.write(chalk.dim(`> Checking: ${urlToCheck}`));

  // Fetch raw HTML of first page & get main content
  const htmlString = await fetch(urlToCheck);
  let context = convert(await htmlString.text());

  // Get all Google Search snippets, clean them up and add to the text
  context += remainingPages
    .reduce((allPages, currentPage) => `${allPages} ${currentPage.snippet}`, "")
    .replaceAll("...", " "); // Remove "..." from Google snippet results;

  // Note: we must stay below the max token amount of OpenAI's API.
  // Max token amount: 4096, 1 token ~= 4 chars in English
  // Hence, we should roughly ensure we stay below 10,000 characters for the input
  // and leave the remaining the tokens for the answer.
  // - https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them
  // - https://platform.openai.com/docs/api-reference/chat/create
  context = context
    .replaceAll("\n", " ") // Remove any new lines from raw HTML of first page
    .trim()
    .substring(0, 10000);

  // Provide OpenAI with the context from the Google Search
  previousChat.push({
    role: "assistant",
    content: context,
  });

  // Step 2: feed search results into OpenAI and answer original question
  previousChat.push({
    role: "user",
    content: `With the information in the assistant's last message, answer this: ${userPrompt}`,
  });

  const finalResponse = await getOpenAIChatCompletion(previousChat);

  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  console.log("\n" + chalk.green("> ") + chalk.white(finalResponse));
  console.log(chalk.dim(`> Know more: ${urlToCheck}` + "\n"));

  return finalResponse;
}

async function getGoogleSearchResults(searchTerm) {
  try {
    const response = await fetch(
      `https://www.googleapis.com/customsearch/v1\?key\=${GOOGLE_SEARCH_API_KEY}\&cx=${GOOGLE_SEARCH_ID}\&q\=${searchTerm}`
    );

    const data = await response.json();
    return data;
  } catch (error) {
    console.error(error);
  }
}

async function getOpenAIChatCompletion(previousChat) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: previousChat,
      }),
    });

    const { choices } = await response.json();
    return choices[0].message.content;
  } catch (error) {
    console.error(error);
  }
}

startCli();
