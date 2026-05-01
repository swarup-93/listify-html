// ============================================================
// Listify HTML — VS Code Extension
// extension.js — Main entry point
// ============================================================

const vscode = require('vscode');

//
// SECTION 1: Text Processing Utilities
//

/**
 * Splits the raw selected text into a clean array of list items.
 * Handles:
 *   - Newline-separated lines
 *   - Comma-separated values ("a, b, c")
 *   - Mixed whitespace / blank lines
 *
 * @param {string} rawText - The raw selected text from the editor
 * @returns {string[]} Array of trimmed, non-empty strings
 */
function parseItems(rawText) {
  const hasNewlines = rawText.includes('\n');
  const hasCommas = rawText.includes(',');

  let items;

  if (!hasNewlines && hasCommas) {
    items = rawText.split(',');
  } else {
    items = rawText.split('\n');
  }

  return items
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

/**
 * Returns true if rawText contains lines with differing leading whitespace,
 * meaning a nested list should be generated instead of a flat one.
 *
 * @param {string} rawText
 * @returns {boolean}
 */
function hasIndentedHierarchy(rawText) {
  const lines = rawText.split('\n').filter(l => l.trim().length > 0);
  const indents = lines.map(l => {
    const m = l.match(/^(\s*)/);
    return m ? m[1].length : 0;
  });
  return indents.some(n => n > 0);
}

/**
 * Parses indented text into a tree structure for nested list generation.
 * Each node: { text: string, depth: number, children: [] }
 *
 * Algorithm:
 *   1. Find the smallest non-zero indent → treat it as "one level".
 *   2. Build flat list of { text, depth } objects.
 *   3. Walk flat list with a stack to assemble a proper tree.
 *
 * @param {string} rawText
 * @returns {{ text: string, depth: number, children: Array }[]} Root-level nodes
 */
function parseIndentedItems(rawText) {
  const lines = rawText
    .split('\n')
    .filter(line => line.trim().length > 0);

  // Measure the smallest non-zero indent as "one level" 
  const indentUnit = lines.reduce((min, line) => {
    const match = line.match(/^(\s+)/);
    if (!match) { return min; }
    return Math.min(min, match[1].length);
  }, Infinity);

  const unitSize = isFinite(indentUnit) ? indentUnit : 1;

  // Build flat list of { text, depth, children } 
  const flatNodes = lines.map(line => {
    const match = line.match(/^(\s*)/);
    const rawIndent = match ? match[1].length : 0;
    return {
      text: line.trim(),
      depth: Math.round(rawIndent / unitSize),
      children: [],
    };
  });

  // Convert flat list → tree using a stack 
  // stack[i] = the most-recently-seen node at depth i
  const roots = [];
  const stack = [];

  for (const node of flatNodes) {
    // Truncate stack to current depth so parent lookup is O(1)
    stack.length = node.depth;

    if (node.depth === 0) {
      roots.push(node);
    } else {
      const parent = stack[node.depth - 1];
      if (parent) {
        parent.children.push(node);
      } else {
        // Orphaned node (indent jumped more than one level) — treat as root
        roots.push(node);
      }
    }

    stack[node.depth] = node;
  }

  return roots;
}

/**
 * Auto-detects whether input looks more like a markdown or HTML list,
 * based on whether items start with "-", "*", or "<li".
 *
 * @param {string[]} items - Parsed list items
 * @returns {'markdown'|'html'} Detected format
 */
function autoDetectFormat(items) {
  const mdPattern = /^[-*]\s/;
  const htmlPattern = /^<li/i;

  let mdCount = 0;
  let htmlCount = 0;

  for (const item of items) {
    if (mdPattern.test(item)) { mdCount++; }
    if (htmlPattern.test(item)) { htmlCount++; }
  }

  return htmlCount > mdCount ? 'html' : 'markdown';
}

//
// SECTION 2: List Generators
//

/**
 * Generates an HTML list string (<ul> or <ol>) — FLAT version.
 *
 * @param {string[]} items      - Array of list item strings
 * @param {'ul'|'ol'} tag       - The wrapper tag
 * @param {string} baseIndent   - Whitespace indent of the first selected line
 * @param {string} innerIndent  - Single-level indent (e.g. "  " or "\t")
 * @returns {string} Formatted HTML list
 */
function generateHtmlList(items, tag, baseIndent, innerIndent) {
  const liLines = items
    .map(item => `${baseIndent}${innerIndent}<li>${escapeHtml(item)}</li>`)
    .join('\n');

  return `${baseIndent}<${tag}>\n${liLines}\n${baseIndent}</${tag}>`;
}

/**
 * Recursively generates a NESTED HTML list from a tree of nodes.
 *
 * @param {{ text: string, children: Array }[]} nodes  - Tree nodes at this level
 * @param {'ul'|'ol'} tag        - Wrapper tag for every level
 * @param {string}    baseIndent - Indentation for the <ul>/<ol> tag itself
 * @param {string}    innerIndent - One indent level (spaces or tab)
 * @returns {string} Fully rendered HTML
 */
function generateNestedHtmlList(nodes, tag, baseIndent, innerIndent) {
  const liLines = nodes.map(node => {
    const escapedText = escapeHtml(node.text);

    if (node.children.length === 0) {
      // Leaf node — simple <li>
      return `${baseIndent}${innerIndent}<li>${escapedText}</li>`;
    }

    // Parent node — <li> contains text + a recursive sub-list
    const childList = generateNestedHtmlList(
      node.children,
      tag,
      baseIndent + innerIndent + innerIndent, // sub-list indented one extra level
      innerIndent,
    );

    return (
      `${baseIndent}${innerIndent}<li>${escapedText}\n` +
      `${childList}\n` +
      `${baseIndent}${innerIndent}</li>`
    );
  }).join('\n');

  return `${baseIndent}<${tag}>\n${liLines}\n${baseIndent}</${tag}>`;
}

/**
 * Generates a Markdown list string — FLAT version.
 *
 * @param {string[]} items    - Array of list item strings
 * @param {'ul'|'ol'} type    - Unordered (dash) or ordered (number)
 * @param {string} baseIndent - Whitespace indent of the first selected line
 * @returns {string} Formatted Markdown list
 */
function generateMarkdownList(items, type, baseIndent) {
  return items
    .map((item, idx) => {
      const prefix = type === 'ol' ? `${idx + 1}.` : '-';
      return `${baseIndent}${prefix} ${item}`;
    })
    .join('\n');
}

/**
 * Recursively generates a NESTED Markdown list from a tree of nodes.
 *
 * @param {{ text: string, children: Array }[]} nodes
 * @param {'ul'|'ol'} type
 * @param {string}    baseIndent - Indent prefix for this level
 * @param {string}    innerIndent - One indent unit
 * @param {number}    [startIdx=0] - Starting index for ordered lists (per-level)
 * @returns {string}
 */
function generateNestedMarkdownList(nodes, type, baseIndent, innerIndent, startIdx = 0) {
  return nodes
    .map((node, idx) => {
      const prefix = type === 'ol' ? `${startIdx + idx + 1}.` : '-';
      const selfLine = `${baseIndent}${prefix} ${node.text}`;

      if (node.children.length === 0) {
        return selfLine;
      }

      const childBlock = generateNestedMarkdownList(
        node.children,
        type,
        baseIndent + innerIndent,
        innerIndent,
      );

      return `${selfLine}\n${childBlock}`;
    })
    .join('\n');
}

/**
 * Escapes special HTML characters in a string.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

//
// SECTION 3: Reverse Feature — HTML list → plain text
//

/**
 * Converts an HTML <ul>/<ol> list back to plain text (one item per line).
 * For nested lists, child items are indented with two spaces per level.
 *
 * @param {string} htmlText - Raw HTML list string
 * @returns {string|null} Plain text or null if no <li> tags found
 */
function reverseHtmlList(htmlText) {
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const matches = [];
  let match;

  while ((match = liRegex.exec(htmlText)) !== null) {
    const plainText = match[1].replace(/<[^>]+>/g, '').trim();
    if (plainText) { matches.push(plainText); }
  }

  return matches.length > 0 ? matches.join('\n') : null;
}

//
// SECTION 4: Editor Helpers
//

/**
 * Returns the indentation string for one level, based on editor settings.
 *
 * @param {vscode.TextEditor} editor
 * @returns {string} e.g. "  " (2 spaces) or "\t"
 */
function getEditorIndent(editor) {
  const { insertSpaces, tabSize } = editor.options;

  if (insertSpaces) {
    return ' '.repeat(Number(tabSize) || 2);
  }
  return '\t';
}

/**
 * Reads the leading whitespace of a given line in the document.
 *
 * @param {vscode.TextDocument} document
 * @param {number} lineIndex
 * @returns {string} e.g. "    " (4 spaces)
 */
function getLineIndent(document, lineIndex) {
  const lineText = document.lineAt(lineIndex).text;
  const match = lineText.match(/^(\s*)/);
  return match ? match[1] : '';
}

//
// SECTION 5: QuickPick UI Helpers
//

/**
 * Presents the list-type QuickPick to the user.
 * Returns the chosen option object, or undefined if dismissed.
 *
 * @returns {Promise<object|undefined>}
 */
async function askListType() {
  const options = [
    {
      label: '$(list-unordered) Unordered List',
      description: '<ul> — bullet points',
      listType: 'ul',
    },
    {
      label: '$(list-ordered) Ordered List',
      description: '<ol> — numbered',
      listType: 'ol',
    },
    {
      label: '$(wand) Auto Detect Format',
      description: 'Detect based on your input',
      listType: 'auto',
    },
  ];

  return vscode.window.showQuickPick(options, {
    placeHolder: 'Select list type',
    title: 'Listify HTML — Choose List Type',
    matchOnDescription: true,
  });
}

/**
 * Presents the output format QuickPick (HTML vs Markdown).
 * Returns the chosen option object, or undefined if dismissed.
 *
 * @returns {Promise<object|undefined>}
 */
async function askOutputFormat() {
  const config = vscode.workspace.getConfiguration('smartListGenerator');
  const defaultFormat = config.get('defaultFormat', 'html');

  const options = [
    {
      label: '$(code) HTML List',
      description: '<ul>/<ol> with <li> tags',
      outputFormat: 'html',
    },
    {
      label: '$(markdown) Markdown List',
      description: '- item  or  1. item',
      outputFormat: 'markdown',
    },
  ];

  // Move the configured default to the top so it's pre-highlighted
  options.sort((a, b) =>
    a.outputFormat === defaultFormat ? -1 : b.outputFormat === defaultFormat ? 1 : 0,
  );

  return vscode.window.showQuickPick(options, {
    placeHolder: 'Select output format',
    title: 'Listify HTML — Choose Output Format',
  });
}

//
// SECTION 6: Main Command — Generate List
//

/**
 * Core handler for the "Generate List" command.
 *
 * Decision tree:
 *   ┌─ Has indented hierarchy? ──YES──► nested path (parseIndentedItems)
 *   │                                    └─ HTML  → generateNestedHtmlList
 *   │                                    └─ MD    → generateNestedMarkdownList
 *   └─ NO ──────────────────────────► flat path  (parseItems)
 *                                      └─ HTML  → generateHtmlList
 *                                      └─ MD    → generateMarkdownList
 */
async function generateListCommand() {
  // ── 6.1  Get the active editor 
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showWarningMessage('Listify HTML: No active editor found.');
    return;
  }

  const selection = editor.selection;
  const rawText = editor.document.getText(selection);

  //  6.2  Guard: empty selection 
  if (!rawText || rawText.trim().length === 0) {
    vscode.window.showWarningMessage(
      'Listify HTML: Please select some text first.',
    );
    return;
  }

  function isUniformIndent(lines) {
    const indents = lines.map(line => {
      const m = line.match(/^(\s*)/);
      return m ? m[1].length : 0;
    });

    const unique = [...new Set(indents)];
    return unique.length === 1;
  }

  //  6.3  Choose parsing strategy 
  const lines = rawText.split('\n').filter(l => l.trim().length > 0);

  const hasIndent = lines.some(l => /^\s+/.test(l));
  const uniformIndent = isUniformIndent(lines);

  const isNested = hasIndent && !uniformIndent;

  // For flat lists we also support comma-separated mode; nested always uses
  // newline splitting, so we call parseItems only in the flat branch.
  let items = null; // used only in flat path
  let treeRoot = null; // used only in nested path

  if (isNested) {
    treeRoot = parseIndentedItems(rawText);
    if (treeRoot.length === 0) {
      vscode.window.showWarningMessage(
        'Listify HTML: No usable text found in selection (only whitespace).',
      );
      return;
    }
  } else {
    items = parseItems(rawText);
    if (items.length === 0) {
      vscode.window.showWarningMessage(
        'Listify HTML: No usable text found in selection (only whitespace).',
      );
      return;
    }
  }

  //  6.4  Prompt for list type 
  const typeChoice = await askListType();
  if (!typeChoice) { return; }

  //  6.5  Prompt for output format
  const formatChoice = await askOutputFormat();
  if (!formatChoice) { return; }

  //  6.6  Resolve "Auto" list type
  let listType = typeChoice.listType; // 'ul', 'ol', or 'auto'

  if (listType === 'auto') {
    const numberedPattern = /^\s*\d+\s*[.)-]\s+/;
    const bulletPattern = /^\s*[-*]\s+/;

    if (isNested) {
      const hasNumbers = hasNumberedItemsInTree(treeRoot, numberedPattern);
      const hasBullets = hasBulletsInTree(treeRoot, bulletPattern);

      if (hasNumbers) {
        listType = 'ol';
        stripNumberingFromTree(treeRoot, numberedPattern);
      } else {
        listType = 'ul';
        if (hasBullets) {
          stripBulletsFromTree(treeRoot, bulletPattern);
        }
      }

    } else {
      const hasNumbers = items.some(item => numberedPattern.test(item));
      const hasBullets = items.some(item => bulletPattern.test(item));

      if (hasNumbers) {
        listType = 'ol';
        items = items.map(item => item.replace(numberedPattern, '').trim());
      } else {
        listType = 'ul';
        if (hasBullets) {
          items = items.map(item => item.replace(bulletPattern, '').trim());
        }
      }
    }
  }

  function hasNumberedItemsInTree(nodes, pattern) {
    for (const node of nodes) {
      if (pattern.test(node.text)) { return true; }
      if (node.children.length > 0) {
        if (hasNumberedItemsInTree(node.children, pattern)) { return true; }
      }
    }
    return false;
  }

  function hasBulletsInTree(nodes, pattern) {
    for (const node of nodes) {
      if (pattern.test(node.text)) { return true; }
      if (node.children.length > 0) {
        if (hasBulletsInTree(node.children, pattern)) { return true; }
      }
    }
    return false;
  }

  function stripBulletsFromTree(nodes, pattern) {
    for (const node of nodes) {
      node.text = node.text.replace(pattern, '').trim();
      if (node.children.length > 0) {
        stripBulletsFromTree(node.children, pattern);
      }
    }
  }

  // 6.7  Read indentation context
  const baseIndent = getLineIndent(editor.document, selection.start.line);
  const innerIndent = getEditorIndent(editor);
  const outputFmt = formatChoice.outputFormat;

  // 6.8  Generate the list string 
  let generatedList;

  if (isNested) {
    // Nested path 
    if (outputFmt === 'html') {
      generatedList = generateNestedHtmlList(treeRoot, listType, baseIndent, innerIndent);
    } else {
      generatedList = generateNestedMarkdownList(treeRoot, listType, baseIndent, innerIndent);
    }
  } else {
    // Flat path (original logic, untouched) 
    if (outputFmt === 'html') {
      generatedList = generateHtmlList(items, listType, baseIndent, innerIndent);
    } else {
      generatedList = generateMarkdownList(items, listType, baseIndent);
    }
  }

  // 6.9  Replace selected text in editor 
  try {
    await editor.edit(editBuilder => {
      editBuilder.replace(selection, generatedList);
    });

    // 6.10  Success notification 
    const count = isNested ? countTreeNodes(treeRoot) : items.length;
    const itemLabel = count === 1 ? 'item' : 'items';
    const nestedNote = isNested ? ' (nested)' : '';

    vscode.window.showInformationMessage(
      `Listify HTML: Generated ${outputFmt.toUpperCase()} ` +
      `<${listType}>${nestedNote} with ${count} ${itemLabel}.`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Listify HTML: Failed to replace text — ${err.message}`,
    );
  }
}

//
// SECTION 6b: Tree Utility Helpers (used by generateListCommand)
//

/**
 * Recursively strips leading numbering (e.g. "1. ", "2) ") from every
 * node's text in the tree.  Mutates nodes in place.
 *
 * @param {{ text: string, children: Array }[]} nodes
 * @param {RegExp} pattern
 */
function stripNumberingFromTree(nodes, pattern) {
  for (const node of nodes) {
    node.text = node.text.replace(pattern, '').trim();
    if (node.children.length > 0) {
      stripNumberingFromTree(node.children, pattern);
    }
  }
}

/**
 * Counts all nodes in the tree (all levels combined).
 *
 * @param {{ children: Array }[]} nodes
 * @returns {number}
 */
function countTreeNodes(nodes) {
  return nodes.reduce((sum, node) => sum + 1 + countTreeNodes(node.children), 0);
}

//
// SECTION 7: Reverse Command — HTML List → Plain Text
//

/**
 * Converts a selected HTML list back to plain-text lines.
 */
async function reverseListCommand() {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showWarningMessage('Listify HTML: No active editor found.');
    return;
  }

  const selection = editor.selection;
  const rawText = editor.document.getText(selection);

  if (!rawText || rawText.trim().length === 0) {
    vscode.window.showWarningMessage(
      'Listify HTML: Please select an HTML list first.',
    );
    return;
  }

  const plainText = reverseHtmlList(rawText);

  if (plainText === null) {
    vscode.window.showWarningMessage(
      'Listify HTML: No <li> tags found in selection. ' +
      'Make sure you have selected a valid HTML list.',
    );
    return;
  }

  try {
    await editor.edit(editBuilder => {
      editBuilder.replace(selection, plainText);
    });

    vscode.window.showInformationMessage(
      'Listify HTML: HTML list converted back to plain text.',
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Listify HTML: Failed to replace text — ${err.message}`,
    );
  }
}

//
// SECTION 8: Extension Lifecycle
//

/**
 * Called by VS Code when the extension is activated.
 *
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('Listify HTML: Extension activated.');

  const generateDisposable = vscode.commands.registerCommand(
    'listifyHTML.generateList',
    generateListCommand,
  );

  const reverseDisposable = vscode.commands.registerCommand(
    'listifyHTML  .reverseList',
    reverseListCommand,
  );

  context.subscriptions.push(generateDisposable, reverseDisposable);
}

/**
 * Called by VS Code when the extension is deactivated.
 */
function deactivate() {
  console.log('Listify HTML: Extension deactivated.');
}

//
// EXPORTS
//
module.exports = { activate, deactivate };
