import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const CHUNK_SIZE = 8000; // characters per chunk
const chunkSize = Math.floor(CHUNK_SIZE * 0.67); // new value, about 33% smaller

async function extractQuestionsFromText(text) {
    const prompt = `
You are an expert exam question extractor.
Given the following text from a PDF, extract all multiple-choice questions.
For each question, return a JSON object with: 'question', 'options' (list), and 'answer'.
If there are no questions, return an empty list.

Text: '''${text}'''

Return ONLY valid JSON without any markdown formatting or code blocks.
  `;

    const completion = await groq.chat.completions.create({
        messages: [
            {
                role: "user",
                content: prompt,
            },
        ],
        model: "llama-3.3-70b-versatile",
        
    });

    let content = completion.choices[0]?.message?.content || "";
    
    // Clean up markdown formatting if present
    content = content.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
    
    return content;
}

function chunkText(text, chunkSize) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}

async function main() {
    // Usage: node extractQuestionsGroq.js <input_text_file> <output_json_file>
    const [, , inputFile, outputFile] = process.argv;
    if (!inputFile || !outputFile) {
        console.error("Usage: node extractQuestionsGroq.js <input_text_file> <output_json_file>");
        process.exit(1);
    }

    const text = fs.readFileSync(inputFile, "utf-8");
    const textChunks = chunkText(text, chunkSize);
    let allQuestions = [];

    for (let i = 0; i < textChunks.length; i++) {
        console.log(`Processing chunk ${i + 1} of ${textChunks.length}...`);
        const questionsJson = await extractQuestionsFromText(textChunks[i]);
        let questions;
        try {
            questions = JSON.parse(questionsJson);
            if (!Array.isArray(questions)) questions = [];
        } catch (e) {
            console.error(`Failed to parse JSON for chunk ${i + 1}:`, e);
            questions = [];
        }
        allQuestions = allQuestions.concat(questions);
    }

    fs.writeFileSync(outputFile, JSON.stringify(allQuestions, null, 2), "utf-8");
    console.log("Questions extracted and saved to", outputFile);
}

main();