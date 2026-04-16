#!/usr/bin/env node
// CLI entry point for claude-adapter
import { Command } from 'commander';
import inquirer from 'inquirer';
import { AdapterConfig } from './types/config';
import { loadConfig, saveConfig, updateClaudeJson, updateClaudeSettings } from './utils/config';
import { createServer, findAvailablePort } from './server';
import { UI } from './utils/ui';
import { checkForUpdates } from './utils/update';
import { getMetadata } from './utils/metadata';
import { Logger } from './utils/logger';
import { version } from '../package.json';

const program = new Command();

program
  .name('claude-adapter')
  .description('Proxy adapter to use OpenAI API with Claude Code')
  .version(version);

program
  .option('-p, --port <port>', 'Port to run the proxy server on', '3080')
  .option('-r, --reconfigure', 'Force reconfiguration even if config exists')
  .option('--no-claude-settings', 'Skip updating Claude Code settings files')
  .option('-l, --log-level <level>', 'Log level (DEBUG, INFO, WARN, ERROR)')
  .action(async (options) => {
    UI.banner();
    UI.header('Adapt any model for Claude Code');

    if (options.logLevel) {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
      if (validLevels.includes(options.logLevel.toUpperCase())) {
        Logger.setGlobalLevel(
          options.logLevel.toUpperCase() as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
        );
      }
    }

    try {
      // Initialize metadata (creates metadata.json on first run)
      getMetadata();

      // Step 1: Update ~/.claude.json for onboarding skip (if enabled)
      if (options.claudeSettings) {
        updateClaudeJson();
        UI.statusDone(true, 'Initialized Claude Adapter');
      } else {
        UI.info('Skipping Claude settings update (--no-claude-settings)');
      }

      // Step 2: Load or create configuration
      let config = loadConfig();

      if (!config || options.reconfigure) {
        UI.log('');
        const existingConfig = options.reconfigure ? config : null;
        config = await promptForConfiguration(existingConfig);
        saveConfig(config);
        console.log(
          `\x1b[2m✔\x1b[0m Tool Format: ${UI.dim(`[${config.toolFormat?.toUpperCase() || 'NATIVE'}]`)}`
        );
        UI.info('Creating Claude Adapter API...');
      } else if (config.toolFormat === undefined) {
        // Existing config missing toolFormat - prompt only for that
        UI.log(''); // Spacing
        const toolStyle = await promptForToolCallingStyle();
        config.toolFormat = toolStyle;
        saveConfig(config);
        console.log(
          `\x1b[2m✔\x1b[0m Tool Format: ${UI.dim(`[${config.toolFormat.toUpperCase()}]`)}`
        );
        UI.info('Tool calling preference saved');
      } else {
        UI.info('Using existing configuration');
        console.log(
          `\x1b[2m✔\x1b[0m Tool Format: ${UI.dim(`[${config.toolFormat.toUpperCase()}]`)}`
        );
      }

      // Step 3: Find available port and start server
      const preferredPort = parseInt(options.port, 10) || 3080;
      const port = await findAvailablePort(preferredPort);

      const server = createServer(config);
      const proxyUrl = await server.start(port);
      UI.statusDone(true, `Claude Adapter running at ${UI.newUrl(proxyUrl)}`);

      // Step 4: Update Claude Code settings (if enabled)
      if (options.claudeSettings) {
        updateClaudeSettings(proxyUrl, config.models);
        UI.statusDone(true, 'Models configured:');

        // Display configured models
        UI.table([
          { label: 'Opus', value: config.models.opus },
          { label: 'Sonnet', value: config.models.sonnet },
          { label: 'Haiku', value: config.models.haiku },
        ]);
      } else {
        UI.info('Claude Code settings not updated (use manual configuration)');
        UI.hint(`Set ANTHROPIC_BASE_URL=${proxyUrl} in your Claude Code settings`);
      }

      UI.success('Claude Adapter is ready!');
      UI.info('Open a new terminal tab and run Claude Code.');
      UI.hint('Press Ctrl+C to stop the proxy server.');

      // Non-blocking update check
      checkForUpdates().then((update) => {
        if (update?.hasUpdate) {
          UI.updateNotify(update.current, update.latest);
        }
        UI.log('');
      });

      // Keep the process running
      process.on('SIGINT', async () => {
        UI.log('');
        await server.stop();
        UI.success('Claude Adapter stopped');
        process.exit(0);
      });
    } catch (error) {
      UI.statusDone(false, 'An error occurred');
      UI.error('Setup failed', error as Error);
      process.exit(1);
    }
  });

/**
 * Prompt user for configuration
 */
async function promptForConfiguration(
  existingConfig?: AdapterConfig | null
): Promise<AdapterConfig> {
  const prefix = UI.dim('?');
  const hasExistingConfig = !!existingConfig?.apiKey;

  // Required configuration prompts
  const requiredAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      prefix,
      message: 'OpenAI-compatible base URL:',
      default: existingConfig?.baseUrl || 'https://api.openai.com/v1',
      transformer: (input: string) => UI.highlight(input),
      validate: (input: string) => {
        try {
          new URL(input);
          return true;
        } catch {
          return 'Please enter a valid URL';
        }
      },
    },
    {
      type: 'input',
      name: 'opusModel',
      prefix,
      message: 'Alternative model for Opus:',
      default: existingConfig?.models?.opus,
      transformer: (input: string) => UI.highlight(input),
      validate: (input: string) => {
        if (!input || input.trim() === '') {
          return 'Model name is required for Opus';
        }
        return true;
      },
    },
  ]);

  let apiKey = existingConfig?.apiKey || '';

  if (!apiKey || hasExistingConfig) {
    const apiKeyAnswer = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        prefix,
        message: hasExistingConfig ? 'API Key (press Enter to keep existing):' : 'API Key:',
        mask: '*',
        transformer: (input: string) => UI.highlight('*'.repeat(input.length)),
        validate: (input: string) => {
          if (!input || input.trim() === '') {
            return hasExistingConfig ? true : 'API key is required';
          }
          return true;
        },
      },
    ]);
    if (apiKeyAnswer.apiKey.trim()) {
      apiKey = apiKeyAnswer.apiKey.trim();
    }
  }

  if (hasExistingConfig) {
    process.stdout.write('\x1b[1A\x1b[2K');
    console.log(`${prefix} API Key: ${UI.dim('[existing]')}`);
  }

  const opusModel = requiredAnswers.opusModel.trim();

  // Sonnet prompt
  const sonnetAnswer = await inquirer.prompt([
    {
      type: 'input',
      name: 'sonnetModel',
      prefix,
      message: 'Alternative model for Sonnet:',
      default: existingConfig?.models?.sonnet,
      transformer: (input: string) => (input ? UI.highlight(input) : ''),
    },
  ]);

  const sonnetModel =
    sonnetAnswer.sonnetModel.trim() || existingConfig?.models?.sonnet || opusModel;

  if (!sonnetAnswer.sonnetModel.trim() && existingConfig?.models?.sonnet) {
    process.stdout.write('\x1b[1A\x1b[2K');
    console.log(
      `${prefix} Alternative model for Sonnet: ${UI.dim(`[${existingConfig.models.sonnet}]`)}`
    );
  } else if (!sonnetAnswer.sonnetModel.trim()) {
    process.stdout.write('\x1b[1A\x1b[2K');
    console.log(`${prefix} Alternative model for Sonnet: ${UI.dim(`[${opusModel}]`)}`);
  }

  // Haiku prompt
  const haikuAnswer = await inquirer.prompt([
    {
      type: 'input',
      name: 'haikuModel',
      prefix,
      message: 'Alternative model for Haiku:',
      default: existingConfig?.models?.haiku,
      transformer: (input: string) => (input ? UI.highlight(input) : ''),
    },
  ]);

  const haikuModel = haikuAnswer.haikuModel.trim() || existingConfig?.models?.haiku || sonnetModel;

  if (!haikuAnswer.haikuModel.trim() && existingConfig?.models?.haiku) {
    process.stdout.write('\x1b[1A\x1b[2K');
    console.log(
      `${prefix} Alternative model for Haiku: ${UI.dim(`[${existingConfig.models.haiku}]`)}`
    );
  } else if (!haikuAnswer.haikuModel.trim()) {
    process.stdout.write('\x1b[1A\x1b[2K');
    console.log(`${prefix} Alternative model for Haiku: ${UI.dim(`[${sonnetModel}]`)}`);
  }

  // Default 模型提示（用于 ANTHROPIC_MODEL 环境变量）
  const defaultModelAnswer = await inquirer.prompt([
    {
      type: 'input',
      name: 'defaultModel',
      prefix,
      message: 'Alternative model for Default:',
      default: existingConfig?.models?.default,
      transformer: (input: string) => (input ? UI.highlight(input) : ''),
    },
  ]);

  const defaultModel =
    defaultModelAnswer.defaultModel.trim() || existingConfig?.models?.default || '';

  if (!defaultModelAnswer.defaultModel.trim() && existingConfig?.models?.default) {
    process.stdout.write('\x1b[1A\x1b[2K');
    console.log(`${prefix} Default model: ${UI.dim(`[${existingConfig.models.default}]`)}`);
  } else if (!defaultModelAnswer.defaultModel.trim()) {
    process.stdout.write('\x1b[1A\x1b[2K');
    console.log(`${prefix} Default model: ${UI.dim('[none]')}`);
  }

  // Tool calling support prompt (after all models are entered)
  const toolSupportAnswer = await inquirer.prompt([
    {
      type: 'list',
      name: 'supportsTools',
      prefix,
      message: 'Do your models support tool/function calling?',
      choices: [
        { name: 'Yes', value: true },
        { name: 'No', value: false },
      ],
      default: true,
    },
  ]);

  let toolFormat: 'native' | 'xml';

  if (toolSupportAnswer.supportsTools) {
    // User selected "Yes" - ask for tool type
    const toolTypeAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'toolType',
        prefix,
        message: 'Select tool/function type:',
        choices: [
          { name: 'XML (Recommended)', value: 'xml' },
          { name: 'Native (Openai Format)', value: 'native' },
        ],
        default: 'xml',
      },
    ]);
    toolFormat = toolTypeAnswer.toolType as 'native' | 'xml';
  } else {
    // User selected "No" - auto-select xml
    console.log(`\x1b[32m✔\x1b[0m Tool Format: ${UI.dim('[XML]')}`);
    toolFormat = 'xml';
  }

  // Header 配置提示
  const hasExistingHeaders = !!(existingConfig?.headers && existingConfig.headers.length > 0);

  const headerAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'addHeaders',
      prefix,
      message: 'Add OpenCode headers (x-opencode-*)?',
      default: hasExistingHeaders,
    },
  ]);

  let headers;
  if (headerAnswer.addHeaders) {
    const existingProjectName =
      existingConfig?.headers?.find((h) => h.name === 'x-opencode-project')?.value || 'opencode';

    const projectNameAnswer = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectName',
        prefix,
        message: 'Project name:',
        default: existingProjectName,
      },
    ]);
    const projectName = projectNameAnswer.projectName.trim() || existingProjectName;
    const existingClientName =
      existingConfig?.headers?.find((h) => h.name === 'x-opencode-client')?.value || 'cli';

    const cliNameAnswer = await inquirer.prompt([
      {
        type: 'input',
        name: 'clientName',
        prefix,
        message: 'Client name:',
        default: existingClientName,
      },
    ]);
    const clientName = cliNameAnswer.clientName.trim() || existingClientName;
    headers = [
      { name: 'x-opencode-project', value: projectName },
      { name: 'x-opencode-client', value: clientName },
      {
        name: 'x-opencode-session',
        generator: '() => crypto.randomUUID()',
        includeForNonStreaming: true,
        includeForStreaming: true,
      },
    ];
    console.log(`\x1b[32m✔\x1b[0m Headers: ${UI.dim('[x-opencode-project, x-opencode-session]')}`);
  }

  return {
    baseUrl: requiredAnswers.baseUrl.trim(),
    apiKey: requiredAnswers.apiKey.trim(),
    models: {
      opus: opusModel,
      sonnet: sonnetModel,
      haiku: haikuModel,
      ...(defaultModel && { default: defaultModel }),
    },
    toolFormat,
    ...(headers && { headers }),
  };
}

/**
 * Prompt only for tool calling style (for existing configs missing this field)
 */
async function promptForToolCallingStyle(): Promise<'native' | 'xml'> {
  const prefix = UI.dim('?');

  const toolSupportAnswer = await inquirer.prompt([
    {
      type: 'list',
      name: 'supportsTools',
      prefix,
      message: 'Do your models support tool/function calling?',
      choices: [
        { name: 'Yes', value: true },
        { name: 'No', value: false },
      ],
      default: true,
    },
  ]);

  if (toolSupportAnswer.supportsTools) {
    // User selected "Yes" - ask for tool type
    const toolTypeAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'toolType',
        prefix,
        message: 'Select tool/function type:',
        choices: [
          { name: 'XML (Recommended)', value: 'xml' },
          { name: 'Native (Openai Format)', value: 'native' },
        ],
        default: 'xml',
      },
    ]);
    return toolTypeAnswer.toolType as 'native' | 'xml';
  } else {
    // User selected "No" - auto-select xml
    console.log(`\x1b[32m✔\x1b[0m Tool Format: ${UI.dim('[XML]')}`);
    return 'xml';
  }
}

// Run the CLI
program.parse();
