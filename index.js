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
  baseElements: { selectors: ["main"] },
  selectors: [
    {
      selector: "a",
      options: { ignoreHref: true },
    },
  ],
});

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

async function fetchContentFromUrl(url) {
  try {
    const htmlString = await fetch(url);
    const content = convert(await htmlString.text());
    return content;
  } catch (error) {
    console.error(chalk.red(`> Failed to fetch content from ${url}`));
    return "";
  }
}

async function performChainedSearch(searchTerm, depth) {
  if (depth <= 0) {
    return "";
  }

  const searchResults = await getGoogleSearchResults(searchTerm);

  if (!searchResults.items) {
    console.log("No search results found. Please try a different query.");
    return "";
  }

  const numTopResults = 2;
  let context = "";

  for (let i = 0; i < numTopResults && i < searchResults.items.length; i++) {
    const currentPage = searchResults.items[i];
    const urlToCheck = currentPage.link;

    process.stdout.cursorTo(0);
    process.stdout.write(chalk.dim(`> Checking (${i + 1}/${numTopResults}): ${urlToCheck}`));

    const currentContext = await fetchContentFromUrl(urlToCheck);
    context += currentContext + "\n\n";

    const urlsInContext = currentContext.match(/https?:\/\/\S+/g) || [];
    for (const url of urlsInContext.slice(0, 2)) {
      const linkedContent = await performChainedSearch(url, depth - 1);
      context += linkedContent + "\n\n";
    }
  }

  return context;
}

async function searchGPT(userPrompt) {
  process.stdout.write(chalk.dim("> Starting Google Search..."));

  // Step 1: perform Google Search
  const searchResults = await getGoogleSearchResults(userPrompt);

  if (!searchResults.items) {
    console.log("No search results found. Please try a different query.");
    return;
  }
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

  // Truncate context if it exceeds the maximum token limit
  const maxContextLength = 3500; // Reduce this value if necessary
  if (context.length > maxContextLength) {
    context = context.substring(0, maxContextLength);
  }

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
  return fetch(
    `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_API_KEY}&cx=${GOOGLE_SEARCH_ID}&q=${searchTerm}`
  )
    .then((response) => response.json())
    .catch((error) => {
      console.error(error);
    });
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

    if (!response.ok) {
      const errorDetails = await response.json();
      console.error("Error in OpenAI API response:", response.statusText, errorDetails);
      return "Sorry, I am unable to provide an answer at the moment.";
    }

    const { choices } = await response.json();
    return choices[0].message.content;
  } catch (error) {
    console.error(error);
    return "Sorry, I encountered an error while processing your request.";
  }
}

startCli();
