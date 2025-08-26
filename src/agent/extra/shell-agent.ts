/**
 * Shell agent implementation with human-in-the-loop capability
 * Converted from sweagent/agent/extra/shell_agent.py
 */

import { DefaultAgent, AgentConfig, ShellAgentConfig, ToolHandler, TemplateConfig, AgentEnvironment } from '../agents';
import { getModel, HumanModel, HumanModelConfig, AbstractModel } from '../models';
import { ProblemStatement, ProblemStatementConfig } from '../problem-statement';
import { AgentRunResult, StepOutput } from '../../types';
import { ActionOnlyParser, AbstractParseFunction } from '../tools/parsing';
import { AbstractHistoryProcessor } from '../history-processors';

/**
 * Shell agent that allows human intervention during execution
 */
export class ShellAgent extends DefaultAgent {
  private originalModel: AbstractModel | null = null;
  private originalParser: AbstractParseFunction | null = null;

  constructor(config: {
    templates: TemplateConfig;
    tools: ToolHandler;
    historyProcessors: AbstractHistoryProcessor[];
    model: AbstractModel;
    maxRequeries?: number;
    name?: string;
  }) {
    super(config);
  }

  static override fromConfig(config: AgentConfig): ShellAgent {
    // Type check to ensure it's actually a ShellAgentConfig
    if (config.type !== 'shell') {
      throw new Error('ShellAgent.fromConfig requires a ShellAgentConfig with type: "shell"');
    }
    // Deep copy config to avoid shared state between different instances
    const shellConfig = JSON.parse(JSON.stringify(config)) as ShellAgentConfig;
    const model = getModel(shellConfig.model, shellConfig.tools);
    return new ShellAgent({
      templates: shellConfig.templates,
      tools: new ToolHandler(shellConfig.tools),
      historyProcessors: shellConfig.historyProcessors,
      model,
      maxRequeries: shellConfig.maxRequeries,
      name: shellConfig.name,
    });
  }

  /**
   * Replace the current model with a HumanModel instance
   * This allows for human intervention during agent execution
   */
  humanStepIn(): void {
    this.originalModel = this.model;
    this.originalParser = this.tools.config.parseFunction as AbstractParseFunction | null;

    const humanConfig: HumanModelConfig = {
      name: 'human',
      costPerCall: 0,
      catchEof: false, // Don't catch EOF in human_step_in mode
    };

    this.model = getModel(humanConfig, this.tools.config);
    // Set parser to ActionOnlyParser
    this.tools.config.parseFunction = new ActionOnlyParser();

    this.logger.info('Switched to human mode. Agent will now accept human input. Press ^D to switch back.');
  }

  /**
   * Switch back to the original model from human mode
   * This is called when ^D is pressed in human mode
   */
  humanStepOut(): void {
    if (!this.originalModel) {
      this.logger.info('No previous model to switch back to. Remaining in current mode.');
      return;
    }

    this.model = this.originalModel;
    this.tools.config.parseFunction = this.originalParser || undefined;
    this.originalModel = null;
    this.originalParser = null;

    this.logger.info('Switched back to AI model mode.');
  }

  /**
   * Run the agent on a problem instance with human intervention capability
   */
  async run(
    env: AgentEnvironment,
    problemStatement: ProblemStatement | ProblemStatementConfig,
    outputDir: string = '.',
  ): Promise<AgentRunResult> {
    await this.setup(env, problemStatement, outputDir);

    // Run action/observation loop
    this.chook.onRunStart();
    let stepOutput: StepOutput = { done: false } as StepOutput;

    while (!stepOutput.done) {
      try {
        stepOutput = await this.step();
        this.saveTrajectory();
      } catch (error) {
        if (error instanceof Error && error.name === 'KeyboardInterrupt') {
          // User pressed ^C, switch to human mode
          if (!(this.model instanceof HumanModel)) {
            this.humanStepIn();
            continue;
          }
          throw error;
        } else if (error instanceof Error && error.name === 'EOFError') {
          // Can only happen if we have a human model, so switch back
          this.logger.info('Detected ^D - switching back to AI mode');
          this.humanStepOut();
          continue;
        } else {
          throw error;
        }
      }

      // If robot is done but not in human mode, switch to human for submission
      if (stepOutput.done && !(this.model instanceof HumanModel)) {
        this.logger.info('Robot is done! Please submit the solution.');
        this.humanStepIn();
        stepOutput.done = false;
      }
    }

    this.chook.onRunDone(this.trajectory, this.info);
    this.logger.info(`Trajectory saved to ${this.trajPath}`);

    // Get trajectory data for return
    const data = this.getTrajectoryData();
    return {
      info: data.info,
      trajectory: data.trajectory,
    };
  }
}
