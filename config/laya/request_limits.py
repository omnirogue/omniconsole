"""Refuse inputs the pinned upstream formatter would shorten."""
import json
import re

IDENTIFIER = re.compile(r"^[a-zA-Z0-9_.:-]{1,96}$")


def check_request(agent, request, render_options, serialize_state):
    if not isinstance(request, dict) or set(request) != {"protocol", "model", "state", "questions"}:
        raise ValueError("invalid_request")
    questions = request["questions"]
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 8:
        raise ValueError("input_too_large")
    state = request["state"]
    if not isinstance(state, (str, dict, list)):
        raise ValueError("invalid_request")
    tok = agent.tok

    def tokens(text):
        if tok.mask_token in text:
            raise ValueError("invalid_request")
        return tok(text, add_special_tokens=False)["input_ids"]

    state_length = len(tokens(serialize_state(state)))
    for name, question in questions.items():
        if not IDENTIFIER.fullmatch(name) or not isinstance(question, dict):
            raise ValueError("invalid_request")
        if not {"type", "instructions"} <= set(question) <= {"type", "instructions", "criteria"}:
            raise ValueError("invalid_request")
        kind, criteria = question["type"], question.get("criteria")
        if kind == "choice":
            if not isinstance(criteria, dict) or not 2 <= len(criteria) <= 20:
                raise ValueError("input_too_large")
            if any(not IDENTIFIER.fullmatch(key) for key in criteria):
                raise ValueError("invalid_request")
        elif kind == "score":
            if not isinstance(criteria, list) or not 2 <= len(criteria) <= 10:
                raise ValueError("invalid_request")
        elif kind == "noul":
            if criteria is not None and (not isinstance(criteria, dict) or not set(criteria) <= {"true", "false"}):
                raise ValueError("invalid_request")
        else:
            raise ValueError("invalid_request")
        internal = agent._to_internal(question)
        option_lengths = [1 + len(tokens(" " + option)) for option in render_options(internal)]
        instruction_length = len(tokens(f"{kind} question: {internal['ins']}"))
        budget = agent.cfg["head_max_len"] - sum(option_lengths)
        if any(length > 49 for length in option_lengths) or budget < 16 or instruction_length > max(8, budget):
            raise ValueError("input_too_large")
        if 4 + instruction_length + sum(option_lengths) + state_length > agent.cfg["max_len"]:
            raise ValueError("input_too_large")


def parse_request(data):
    def reject_constant(_):
        raise ValueError("invalid_request")

    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("invalid_request")
            result[key] = value
        return result

    return json.loads(data, parse_constant=reject_constant, object_pairs_hook=unique_keys)
