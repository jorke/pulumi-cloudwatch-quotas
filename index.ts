import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

type WidgetConfig = {
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    properties: any;
};

type QuotaDefinition = {
    metrics: string[];
    modelId: string;
};

const EMAIL_ADDRESSES: string[] = ["jorkeo@amazon.com"];

// Optimized quota definitions with direct lookup by quota code
const quotaDefinitions: Record<string, QuotaDefinition> = {
    // Claude 3 Haiku
    "L-DCADBC78": { metrics: ["InputTokenCount", "OutputTokenCount"], modelId: "us.anthropic.claude-3-haiku-20240307-v1:0" },
    "L-616A3F5B": { metrics: ["Invocations", "InvocationThrottles"], modelId: "us.anthropic.claude-3-haiku-20240307-v1:0" },

    // Claude 3.5 Haiku
    "L-4BF37C17": { metrics: ["InputTokenCount", "OutputTokenCount"], modelId: "us.anthropic.claude-3-5-haiku-20241022-v1:0" },
    "L-252DF594": { metrics: ["Invocations", "InvocationThrottles"], modelId: "us.anthropic.claude-3-5-haiku-20241022-v1:0" },

    // Claude 3.5 Sonnet v2
    "L-FF8B4E28": { metrics: ["InputTokenCount", "OutputTokenCount"], modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0" },
    "L-1D3E59A3": { metrics: ["Invocations", "InvocationThrottles"], modelId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0" },

    // Claude 3.7 Sonnet
    "L-6E888CC2": { metrics: ["InputTokenCount", "OutputTokenCount"], modelId: "us.anthropic.claude-3-7-sonnet-20250219-v1:0" },
    "L-3D8CC480": { metrics: ["Invocations", "InvocationThrottles"], modelId: "us.anthropic.claude-3-7-sonnet-20250219-v1:0" },

    // Cohere Embed
    "L-C2F86908": { metrics: ["InputTokenCount", "OutputTokenCount"], modelId: "cohere.embed-multilingual-v3" },
    "L-9E5BD0C6": { metrics: ["Invocations", "InvocationThrottles"], modelId: "cohere.embed-multilingual-v3" }
};

// Get all quota codes directly from the definitions
const quotaCodes = Object.keys(quotaDefinitions);

// Create an SNS topic for alarms
const alarmTopic = new aws.sns.Topic("bedrock-quota-alarm-topic", {
    displayName: "Bedrock Quota Alarm Notifications"
});

// Subscribe email addresses to the topic
EMAIL_ADDRESSES.forEach((email, i) => {
    new aws.sns.TopicSubscription(`email-subscription-${i}`, {
        topic: alarmTopic.arn,
        protocol: "email",
        endpoint: email,
    });
});

// Quota codes are already defined above

// Fetch quota values from AWS
const quotas = quotaCodes.map(code => {
    return aws.servicequotas.getServiceQuota({
        quotaCode: code,
        serviceCode: "bedrock",
    });
});

function createQuotaWidget(modelId: string, quota: aws.servicequotas.GetServiceQuotaResult,
    quotaDefinition: QuotaDefinition, x: number, y: number): WidgetConfig {

    return {
        type: "metric",
        x,
        y,
        width: 6,
        height: 6,
        properties: {
            metrics: [
                ...quotaDefinition.metrics.map((metric, idx) =>
                    ["AWS/Bedrock", metric, "ModelId", modelId, { id: `m${idx}` }]
                ),
                ...(quotaDefinition.metrics.length > 1 ? [[
                    {
                        expression: quotaDefinition.metrics.map((_, idx) => `m${idx}`).join('+'),
                        label: 'Total',
                        color: '#1f77b4'
                    }
                ]] : [])
            ],
            period: 300,
            stat: quotaDefinition.metrics.some(m => /TokenCount/g.test(m)) ? "Sum" : "SampleCount",
            region: aws.config.region,
            title: `${modelId}|${quota.quotaCode}|${quota.quotaName}`,
            annotations: {
                horizontal: [{
                    label: `Quota`,
                    value: quota.value,
                    color: "#ff9900"
                }]
            }
        }
    };
}

function createPeakUsageWidget(modelId: string, x: number, y: number): WidgetConfig {
    return {
        type: "metric",
        x,
        y,
        width: 6,
        height: 6,
        properties: {
            view: "singleValue",
            metrics: [
                ["AWS/Bedrock", "InputTokenCount", "ModelId", modelId, { "stat": "p99", label: 'Peak InputTokenCount' }],
                ["AWS/Bedrock", "OutputTokenCount", "ModelId", modelId, { "stat": "p99", label: 'Peak OutputTokenCount' }],
                ["AWS/Bedrock", "Invocations", "ModelId", modelId, { "stat": "tc99", label: 'Invocations' }],
                ["AWS/Bedrock", "InvocationThrottles", "ModelId", modelId, { "stat": "tc99", label: 'InvocationThrottles' }]
            ],
            period: 86400,
            region: aws.config.region,
            title: `Daily p99/tc99|${modelId}`
        }
    };
}

function createDailyTotalWidget(modelId: string, x: number, y: number): WidgetConfig {
    return {
        type: "metric",
        x,
        y,
        width: 6,
        height: 6,
        properties: {
            view: "singleValue",
            metrics: [
                ["AWS/Bedrock", "InputTokenCount", "ModelId", modelId],
                ["AWS/Bedrock", "OutputTokenCount", "ModelId", modelId],
                ["AWS/Bedrock", "Invocations", "ModelId", modelId]
            ],
            period: 86400,
            stat: "Sum",
            region: aws.config.region,
            title: `Daily Total|${modelId}`
        }
    };
}

// Create CloudWatch dashboard
const dashboard = new aws.cloudwatch.Dashboard("bedrock-metrics-dashboard", {
    dashboardName: "BedrockQuotaDash",
    dashboardBody: pulumi.all(quotas).apply(quotaResults => {

        const quotasByModel: Record<string, aws.servicequotas.GetServiceQuotaResult[]> = {};
        quotaResults.forEach(quota => {
            const modelId = quotaDefinitions[quota.quotaCode].modelId;
            if (!quotasByModel[modelId]) {
                quotasByModel[modelId] = [];
            }
            quotasByModel[modelId].push(quota);
        });

        const allWidgets: WidgetConfig[] = [];
        let rowY = 0;

        // For each model, create a row of widgets
        Object.entries(quotasByModel).forEach(([modelId, modelQuotaResults]) => {

            modelQuotaResults.forEach((quota, i) => {
                const quotaDefinition = quotaDefinitions[quota.quotaCode];
                if (!quotaDefinition) {
                    throw new Error(`Quota definition not found for code ${quota.quotaCode}`);
                }

                allWidgets.push(createQuotaWidget(modelId, quota, quotaDefinition, i * 6, rowY));
            });

            // Add peak usage and daily total widgets
            allWidgets.push(createPeakUsageWidget(modelId, modelQuotaResults.length * 6, rowY));
            allWidgets.push(createDailyTotalWidget(modelId, (modelQuotaResults.length + 1) * 6, rowY));

            // Move to next row
            rowY += 8;
        });

        return JSON.stringify({ widgets: allWidgets });
    })
});

// Create CloudWatch alarms - one per quota
// Define alarm threshold percentages
const HIGH_ALARM_THRESHOLD_PERCENTAGE = 0.95;
const CONSTANT_ALARM_THRESHOLD_PERCENTAGE = 0.8;

function createQuotaAlarms(quota: aws.servicequotas.GetServiceQuotaResult): aws.cloudwatch.MetricAlarm[] {
    const quotaDefinition = quotaDefinitions[quota.quotaCode];
    if (!quotaDefinition) {
        throw new Error(`Quota definition not found for code ${quota.quotaCode}`);
    }

    // Create two alarms with different configurations
    return [
        createSingleQuotaAlarm(quota, quotaDefinition, HIGH_ALARM_THRESHOLD_PERCENTAGE, 60, "high"),
        createSingleQuotaAlarm(quota, quotaDefinition, CONSTANT_ALARM_THRESHOLD_PERCENTAGE, 1800, "constant")
    ];
}

function createSingleQuotaAlarm(
    quota: aws.servicequotas.GetServiceQuotaResult,
    quotaDefinition: QuotaDefinition,
    thresholdPercentage: number,
    periodSeconds: number,
    severity: string
): aws.cloudwatch.MetricAlarm {
    let metricAlarm: any = {
        alarmDescription: `Alarm when Bedrock metrics exceed ${thresholdPercentage * 100}% of quota ${quota.quotaName} (${quotaDefinition.modelId})`,

        comparisonOperator: "GreaterThanThreshold",
        evaluationPeriods: 1,
        threshold: quota.value * thresholdPercentage,
        alarmActions: [alarmTopic.arn],
        treatMissingData: "notBreaching"
    }

    if (quotaDefinition.metrics.length > 1) {
        metricAlarm = {
            ...metricAlarm,
            ...{
                metricQueries: [
                    {
                        id: "e1",
                        expression: quotaDefinition.metrics.map((_, idx) => `m${idx}`).join("+"),
                        label: "Combined Metrics",
                        returnData: true
                    },
                    ...quotaDefinition.metrics.map((metric, idx) => ({
                        id: `m${idx}`,
                        metric: {
                            namespace: "AWS/Bedrock",
                            metricName: metric,
                            dimensions: { ModelId: quotaDefinition.modelId },
                            period: periodSeconds,
                            stat: "Sum"
                        },
                        returnData: false
                    }))
                ],
            }
        }
    } else {
        metricAlarm = {
            ...metricAlarm,
            ...{
                namespace: "AWS/Bedrock",
                metricName: quotaDefinition.metrics[0],
                period: periodSeconds,
                statistic: "Sum",
                dimensions: { ModelId: quotaDefinition.modelId },
            }
        }
    }

    return new aws.cloudwatch.MetricAlarm(`bedrock-quota-alarm-${quota.quotaCode}-${severity}`, metricAlarm);
}

const alarms = pulumi.all(quotas).apply(quotaResults => {
    return quotaResults.flatMap(createQuotaAlarms);
});

// Export the dashboard URL
export const dashboardUrl = pulumi.interpolate`https://${aws.config.region}.console.aws.amazon.com/cloudwatch/home?region=${aws.config.region}#dashboards:name=${dashboard.dashboardName}`;

// Export quota values for reference
export const quotaValues = quotas.map(async quota => ({
    quotaCode: (await quota).quotaCode,
    quotaName: (await quota).quotaName,
    value: (await quota).value,
    modelId: quotaDefinitions[(await quota).quotaCode].modelId
}));

// Export alarm ARNs
export const alarmArns = alarms.apply(alarmArray =>
    alarmArray.map(alarm => alarm.arn)
);