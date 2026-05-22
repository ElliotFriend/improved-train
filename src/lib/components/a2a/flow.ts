export type FlowStepKind =
    | 'request'
    | 'challenge'
    | 'protocol'
    | 'sign'
    | 'submit'
    | 'settled'
    | 'verify'
    | 'data'
    | 'error';

export interface FlowStep {
    kind: FlowStepKind;
    label: string;
    detail?: string;
    link?: { href: string; text: string };
    /**
     * Marks the step as still in progress so the renderer can show a spinner.
     * Cleared when the next step appears.
     */
    pending?: boolean;
}
